"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

/**
 * Single Source of Truth SQLite store (Node 22 built-in node:sqlite, zero external deps).
 *
 * Replaces the fragmented board.json, notices.json, ui.json, activity.json,
 * in-memory cooldown Maps, and duplicate manifest copies with one ACID WAL store.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  original_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'desktop',
  source_ref TEXT,
  project_name TEXT,
  project_path TEXT,
  stakes TEXT NOT NULL DEFAULT 'standard',
  stage TEXT NOT NULL DEFAULT 'intake',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_agent TEXT,
  assigned_model TEXT,
  assigned_effort TEXT,
  builder_agent TEXT,
  auditor_agent TEXT,
  branch TEXT,
  worktree_path TEXT,
  audit_round INTEGER NOT NULL DEFAULT 0,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  put_away INTEGER NOT NULL DEFAULT 0,
  stop_requested_at INTEGER,
  retry_after INTEGER,
  started_at INTEGER,
  last_activity TEXT,
  last_activity_at INTEGER,
  brief_json TEXT,
  delivery_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_ref
  ON tasks(source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS thread_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  agent TEXT,
  kind TEXT NOT NULL DEFAULT 'message',
  content TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_task ON thread_messages(task_id, id);

CREATE TABLE IF NOT EXISTS bus_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  msg_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bus_messages_task ON bus_messages(task_id, id);

CREATE TABLE IF NOT EXISTS quotas (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'available',
  reset_at INTEGER,
  reason TEXT,
  raw_message TEXT,
  observed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  effort_levels_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  is_default INTEGER NOT NULL DEFAULT 0,
  discovered_at INTEGER NOT NULL,
  verified_at INTEGER
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  choices_json TEXT NOT NULL,
  link TEXT,
  link_label TEXT,
  code TEXT,
  service TEXT,
  digest TEXT NOT NULL,
  meta_json TEXT,
  answer_value TEXT,
  answer_source TEXT,
  answered_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_open ON approvals(answered_at, created_at);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function digestOf(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

function hydrateTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    originalText: row.original_text,
    source: row.source,
    sourceRef: row.source_ref,
    projectName: row.project_name,
    projectPath: row.project_path,
    stakes: row.stakes,
    stage: row.stage,
    status: row.status,
    assignedAgent: row.assigned_agent,
    assignedModel: row.assigned_model,
    assignedEffort: row.assigned_effort,
    builderAgent: row.builder_agent,
    auditorAgent: row.auditor_agent,
    branch: row.branch,
    worktreePath: row.worktree_path,
    auditRound: row.audit_round,
    escalationLevel: row.escalation_level,
    putAway: row.put_away === 1,
    stopRequestedAt: row.stop_requested_at,
    retryAfter: row.retry_after,
    startedAt: row.started_at,
    lastActivity: row.last_activity,
    lastActivityAt: row.last_activity_at,
    brief: parseJson(row.brief_json, null),
    delivery: parseJson(row.delivery_json, null),
    errorText: row.error_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    title: row.title,
    prompt: row.prompt,
    choices: parseJson(row.choices_json, []),
    link: row.link,
    linkLabel: row.link_label,
    code: row.code,
    service: row.service,
    digest: row.digest,
    meta: parseJson(row.meta_json, null),
    answerValue: row.answer_value,
    answerSource: row.answer_source,
    answeredAt: row.answered_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function hydrateModel(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    tier: row.tier,
    effortLevels: parseJson(row.effort_levels_json, []),
    status: row.status,
    isDefault: row.is_default === 1,
    discoveredAt: row.discovered_at,
    verifiedAt: row.verified_at,
  };
}

function createStore({ dbPath, now = Date.now } = {}) {
  if (!dbPath) throw new Error("dbPath is required");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);

  function getKv(key, fallback = null) {
    const row = db.prepare("SELECT value_json FROM kv WHERE key = ?").get(key);
    return row ? parseJson(row.value_json, fallback) : fallback;
  }

  function setKv(key, value) {
    const at = now();
    db.prepare(`
      INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), at);
    return value;
  }

  function getQueueState() {
    return getKv("queue", { paused: false, stopVersion: 0 });
  }

  function setQueuePaused(paused) {
    const current = getQueueState();
    if (current.paused === Boolean(paused)) return current;
    return setKv("queue", {
      paused: Boolean(paused),
      stopVersion: current.stopVersion + (paused ? 1 : 0),
    });
  }

  function getFocus() {
    return getKv("focus", null);
  }

  function setFocus(taskId) {
    if (taskId !== null && !getTask(taskId)) {
      throw Object.assign(new Error(`Task "${taskId}" does not exist.`), { code: "TASK_MISSING" });
    }
    return setKv("focus", taskId);
  }

  function nextTaskSeq() {
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM tasks").get();
    return Number(row.max_seq || 0) + 1;
  }

  function createTask({
    id = null,
    title = null,
    text,
    source = "desktop",
    sourceRef = null,
    projectName = null,
    projectPath = null,
    stakes = "standard",
    stage = "intake",
    status = "open",
    assignedAgent = null,
    brief = null,
  }) {
    const cleanText = String(text || "").trim();
    if (!cleanText) throw Object.assign(new Error("Task text is required."), { code: "INVALID_TASK" });
    if (cleanText.length > 32000) throw Object.assign(new Error("Task text exceeds 32,000 characters."), { code: "INVALID_TASK" });

    if (sourceRef) {
      const existing = db.prepare("SELECT * FROM tasks WHERE source = ? AND source_ref = ?").get(source, sourceRef);
      if (existing) {
        if (existing.original_text !== cleanText) {
          throw Object.assign(new Error("Source reference already exists with different text."), { code: "SOURCE_CONFLICT" });
        }
        return hydrateTask(existing);
      }
    }

    const seq = nextTaskSeq();
    const taskId = id || `T${seq}`;
    const cleanTitle = (title && String(title).trim()) || cleanText.replace(/\s+/g, " ").slice(0, 72);
    const at = now();

    db.prepare(`
      INSERT INTO tasks (
        id, seq, title, original_text, source, source_ref,
        project_name, project_path, stakes, stage, status,
        assigned_agent, brief_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId, seq, cleanTitle, cleanText, source, sourceRef,
      projectName, projectPath, stakes, stage, status,
      assignedAgent, brief ? JSON.stringify(brief) : null, at, at
    );

    addThreadMessage({ taskId, role: "owner", kind: "message", content: cleanText, meta: { source } });
    return getTask(taskId);
  }

  function getTask(id) {
    return hydrateTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
  }

  function listTasks({ includePutAway = false, status = null, projectName = null } = {}) {
    const clauses = [];
    const params = [];
    if (!includePutAway) clauses.push("put_away = 0");
    if (status) { clauses.push("status = ?"); params.push(status); }
    if (projectName) { clauses.push("project_name = ?"); params.push(projectName); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM tasks ${where} ORDER BY seq ASC`).all(...params).map(hydrateTask);
  }

  const FIELD_MAP = Object.freeze({
    title: "title",
    projectName: "project_name",
    projectPath: "project_path",
    stakes: "stakes",
    stage: "stage",
    status: "status",
    assignedAgent: "assigned_agent",
    assignedModel: "assigned_model",
    assignedEffort: "assigned_effort",
    builderAgent: "builder_agent",
    auditorAgent: "auditor_agent",
    branch: "branch",
    worktreePath: "worktree_path",
    auditRound: "audit_round",
    escalationLevel: "escalation_level",
    putAway: "put_away",
    stopRequestedAt: "stop_requested_at",
    retryAfter: "retry_after",
    startedAt: "started_at",
    lastActivity: "last_activity",
    lastActivityAt: "last_activity_at",
    brief: "brief_json",
    delivery: "delivery_json",
    errorText: "error_text",
  });

  function updateTask(id, patch) {
    const sets = [];
    const params = [];
    for (const [key, rawVal] of Object.entries(patch || {})) {
      const col = FIELD_MAP[key];
      if (!col) continue;
      sets.push(`${col} = ?`);
      if (col === "put_away") params.push(rawVal ? 1 : 0);
      else if (col.endsWith("_json")) params.push(rawVal === null || rawVal === undefined ? null : JSON.stringify(rawVal));
      else params.push(rawVal === undefined ? null : rawVal);
    }
    if (!sets.length) return getTask(id);
    sets.push("updated_at = ?");
    params.push(now(), id);
    const info = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (info.changes === 0) throw Object.assign(new Error(`Task "${id}" not found.`), { code: "TASK_MISSING" });
    return getTask(id);
  }

  /** Atomic claim: only succeeds if status is 'open' and queue isn't paused. */
  function claimTask(id, { agent, model = null, effort = null, stage = null }) {
    const queue = getQueueState();
    if (queue.paused) throw Object.assign(new Error("Queue is paused."), { code: "QUEUE_PAUSED" });
    const at = now();
    const info = db.prepare(`
      UPDATE tasks
      SET status = 'running',
          stage = COALESCE(?, stage),
          assigned_agent = ?,
          assigned_model = ?,
          assigned_effort = ?,
          started_at = ?,
          retry_after = NULL,
          stop_requested_at = NULL,
          error_text = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'open' AND put_away = 0
    `).run(stage, agent, model, effort, at, at, id);
    if (info.changes === 0) {
      throw Object.assign(new Error(`Task "${id}" is not open to claim.`), { code: "TASK_NOT_OPEN" });
    }
    return { task: getTask(id), stopVersion: queue.stopVersion, claimedAt: at };
  }

  function addThreadMessage({ taskId, role, agent = null, kind = "message", content, meta = null }) {
    const at = now();
    const res = db.prepare(`
      INSERT INTO thread_messages (task_id, role, agent, kind, content, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, role, agent, kind, String(content || ""), meta ? JSON.stringify(meta) : null, at);
    return { id: Number(res.lastInsertRowid), taskId, role, agent, kind, content: String(content || ""), meta, createdAt: at };
  }

  function getThread(taskId) {
    return db.prepare("SELECT * FROM thread_messages WHERE task_id = ? ORDER BY id ASC").all(taskId).map(row => ({
      id: row.id,
      taskId: row.task_id,
      role: row.role,
      agent: row.agent,
      kind: row.kind,
      content: row.content,
      meta: parseJson(row.meta_json, null),
      createdAt: row.created_at,
    }));
  }

  function addBusMessage({ taskId, fromAgent, toAgent, msgType, payload }) {
    const at = now();
    const res = db.prepare(`
      INSERT INTO bus_messages (task_id, from_agent, to_agent, msg_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, fromAgent, toAgent, msgType, JSON.stringify(payload ?? {}), at);
    return { id: Number(res.lastInsertRowid), taskId, fromAgent, toAgent, msgType, payload: payload ?? {}, createdAt: at };
  }

  function getBusMessages(taskId) {
    return db.prepare("SELECT * FROM bus_messages WHERE task_id = ? ORDER BY id ASC").all(taskId).map(row => ({
      id: row.id,
      taskId: row.task_id,
      fromAgent: row.from_agent,
      toAgent: row.to_agent,
      msgType: row.msg_type,
      payload: parseJson(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  // --- Persistent Quotas ---
  function setQuota({ provider, status, resetAt = null, reason = null, rawMessage = null }) {
    const at = now();
    db.prepare(`
      INSERT INTO quotas (provider, status, reset_at, reason, raw_message, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        status = excluded.status,
        reset_at = excluded.reset_at,
        reason = excluded.reason,
        raw_message = excluded.raw_message,
        observed_at = excluded.observed_at
    `).run(provider, status, resetAt, reason, rawMessage, at);
    return getQuota(provider);
  }

  function getQuota(provider) {
    const row = db.prepare("SELECT * FROM quotas WHERE provider = ?").get(provider);
    if (!row) return { provider, status: "available", resetAt: null, reason: null, rawMessage: null, observedAt: null };
    return {
      provider: row.provider,
      status: row.status,
      resetAt: row.reset_at,
      reason: row.reason,
      rawMessage: row.raw_message,
      observedAt: row.observed_at,
    };
  }

  function listQuotas() {
    return db.prepare("SELECT * FROM quotas ORDER BY provider ASC").all().map(row => ({
      provider: row.provider,
      status: row.status,
      resetAt: row.reset_at,
      reason: row.reason,
      rawMessage: row.raw_message,
      observedAt: row.observed_at,
    }));
  }

  function clearQuota(provider) {
    db.prepare("DELETE FROM quotas WHERE provider = ?").run(provider);
  }

  // --- Model Catalog ---
  function upsertModel({ provider, modelId, tier, effortLevels = ["medium"], status = "discovered", isDefault = false, verifiedAt = null }) {
    const id = `${provider}:${modelId}`;
    const at = now();
    const existing = db.prepare("SELECT * FROM models WHERE id = ?").get(id);
    if (existing) {
      db.prepare(`
        UPDATE models
        SET tier = ?, effort_levels_json = ?, status = ?, is_default = ?, verified_at = COALESCE(?, verified_at)
        WHERE id = ?
      `).run(tier, JSON.stringify(effortLevels), status, isDefault ? 1 : 0, verifiedAt, id);
    } else {
      db.prepare(`
        INSERT INTO models (id, provider, model_id, tier, effort_levels_json, status, is_default, discovered_at, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, provider, modelId, tier, JSON.stringify(effortLevels), status, isDefault ? 1 : 0, at, verifiedAt);
    }
    return hydrateModel(db.prepare("SELECT * FROM models WHERE id = ?").get(id));
  }

  function listModels({ provider = null, tier = null, status = null } = {}) {
    const clauses = [];
    const params = [];
    if (provider) { clauses.push("provider = ?"); params.push(provider); }
    if (tier) { clauses.push("tier = ?"); params.push(tier); }
    if (status) { clauses.push("status = ?"); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM models ${where} ORDER BY is_default DESC, discovered_at DESC`).all(...params).map(hydrateModel);
  }

  function setDefaultModel(provider, tier, modelId) {
    const id = `${provider}:${modelId}`;
    db.prepare("UPDATE models SET is_default = 0 WHERE provider = ? AND tier = ?").run(provider, tier);
    db.prepare("UPDATE models SET is_default = 1, status = 'promoted' WHERE id = ?").run(id);
    return hydrateModel(db.prepare("SELECT * FROM models WHERE id = ?").get(id));
  }

  function removeModel(provider, modelId) {
    const id = `${provider}:${modelId}`;
    const info = db.prepare("DELETE FROM models WHERE id = ?").run(id);
    return info.changes > 0;
  }

  // --- Approvals & Auth Requests ---
  function createApproval({
    taskId = null,
    kind = "approval",
    title,
    prompt,
    choices = [],
    link = null,
    linkLabel = null,
    code = null,
    service = null,
    meta = null,
    ttlMs = APPROVAL_TTL_MS,
  }) {
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM approvals").get();
    const seq = Number(row.max_seq || 0) + 1;
    const id = `A${seq}`;
    const at = now();
    const digest = digestOf({ id, taskId, kind, title, prompt, choices, service, at });
    db.prepare(`
      INSERT INTO approvals (
        id, seq, task_id, kind, title, prompt, choices_json,
        link, link_label, code, service, digest, meta_json,
        expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, seq, taskId, kind, String(title || kind), String(prompt || ""),
      JSON.stringify(choices), link, linkLabel, code, service, digest,
      meta ? JSON.stringify(meta) : null, at + ttlMs, at
    );
    return getApproval(id);
  }

  function getApproval(id) {
    return hydrateApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id));
  }

  function listOpenApprovals({ taskId = null, kind = null } = {}) {
    const at = now();
    const clauses = ["answered_at IS NULL", "expires_at > ?"];
    const params = [at];
    if (taskId) { clauses.push("task_id = ?"); params.push(taskId); }
    if (kind) { clauses.push("kind = ?"); params.push(kind); }
    return db.prepare(`SELECT * FROM approvals WHERE ${clauses.join(" AND ")} ORDER BY seq ASC`).all(...params).map(hydrateApproval);
  }

  function answerApproval({ id, value, digest, source = "desktop" }) {
    const item = getApproval(id);
    if (!item) throw Object.assign(new Error("Approval not found."), { code: "APPROVAL_MISSING" });
    if (item.answeredAt) throw Object.assign(new Error("Approval already answered."), { code: "APPROVAL_ANSWERED" });
    if (now() > item.expiresAt) throw Object.assign(new Error("Approval expired."), { code: "APPROVAL_EXPIRED" });
    if (digest !== item.digest) throw Object.assign(new Error("Approval digest mismatch."), { code: "APPROVAL_MISMATCH" });
    if (item.choices.length && !item.choices.some(c => c.value === value)) {
      throw Object.assign(new Error("Invalid choice."), { code: "INVALID_CHOICE" });
    }
    const at = now();
    db.prepare("UPDATE approvals SET answer_value = ?, answer_source = ?, answered_at = ? WHERE id = ?")
      .run(String(value), source, at, id);
    return getApproval(id);
  }

  function resolveAuthApproval(id, outcomeValue = "signed_in") {
    const item = getApproval(id);
    if (!item || item.answeredAt) return item;
    const at = now();
    db.prepare("UPDATE approvals SET answer_value = ?, answer_source = 'auth-broker', answered_at = ? WHERE id = ?")
      .run(outcomeValue, at, id);
    return getApproval(id);
  }

  function recoverInterruptedTasks() {
    const running = listTasks({ status: "running" });
    for (const task of running) {
      updateTask(task.id, {
        status: "waiting",
        stage: "waiting_user",
        errorText: "Interrupted when the OS daemon stopped. Ready to resume from saved worktree.",
      });
      addThreadMessage({
        taskId: task.id,
        role: "system",
        kind: "status",
        content: "This task was interrupted when the computer or daemon stopped. Press Continue to pick up from the saved worktree.",
      });
    }
    return running.length;
  }

  function close() {
    db.close();
  }

  return {
    db,
    getKv,
    setKv,
    getQueueState,
    setQueuePaused,
    getFocus,
    setFocus,
    createTask,
    getTask,
    listTasks,
    updateTask,
    claimTask,
    addThreadMessage,
    getThread,
    addBusMessage,
    getBusMessages,
    setQuota,
    getQuota,
    listQuotas,
    clearQuota,
    upsertModel,
    listModels,
    setDefaultModel,
    removeModel,
    createApproval,
    getApproval,
    listOpenApprovals,
    answerApproval,
    resolveAuthApproval,
    recoverInterruptedTasks,
    close,
  };
}

module.exports = { createStore, SCHEMA_SQL, APPROVAL_TTL_MS };
