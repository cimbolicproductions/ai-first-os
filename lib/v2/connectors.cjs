"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listAllProjects, resolveProject, stakesForProject } = require("./profile.cjs");

/**
 * Bidirectional Intake Connectors (Muse v2 + GrokBot Local Daemon) + Optional Sheet Sync.
 *
 * Fixes v1's blind one-way Muse connector and dead GrokBot stub:
 * - Muse & GrokBot can start threads, relay owner replies into existing threads,
 *   OR conduct upfront Q&A in their own chat and hand a locked brief straight to
 *   the terminal Planner.
 * - Status responses expose live activity, questions, clickable 1-tap auth links,
 *   queue pause state, and the complete Total Output delivery card.
 * - Approvals remain strictly owner-tapped via digest (connectors can never forge YES).
 */

function formatIntakeReceipt({ store, task }) {
  const queuePaused = store.getQueueState().paused;
  const thread = store.getThread(task.id);
  const openApprovals = store.listOpenApprovals({ taskId: task.id });
  const authCard = openApprovals.find(a => a.kind === "auth") || null;
  const approvalCard = openApprovals.find(a => a.kind === "approval" || a.kind === "ship") || null;
  const lastQuestion = [...thread].reverse().find(m => m.kind === "question")?.content || null;

  return {
    ok: true,
    task_id: task.id,
    title: task.title,
    project: task.projectName,
    stakes: task.stakes,
    stage: task.stage,
    status: task.status,
    queue_paused: queuePaused,
    assigned_agent: task.assignedAgent,
    assigned_model: task.assignedModel,
    assigned_effort: task.assignedEffort,
    last_activity: task.lastActivity,
    ...(task.stage === "waiting_user" && lastQuestion ? { question: lastQuestion } : {}),
    ...(authCard ? {
      auth_required: {
        approval_id: authCard.id,
        service: authCard.service,
        prompt: authCard.prompt,
        link: authCard.link,
        code: authCard.code,
      },
    } : {}),
    ...(approvalCard ? {
      approval_required: {
        approval_id: approvalCard.id,
        kind: approvalCard.kind,
        title: approvalCard.title,
        prompt: approvalCard.prompt,
      },
    } : {}),
    ...(task.delivery ? { delivery: task.delivery } : {}),
    ...(task.errorText ? { error: task.errorText } : {}),
    updated_at: new Date(task.updatedAt).toISOString(),
  };
}

function createIntakeBridge({ store, pipeline, getProfile, onTaskQueued = () => {} }) {
  function submit({ connector = "muse", text, idempotencyKey = null, projectName = null }) {
    const clean = String(text || "").trim();
    if (!clean) throw Object.assign(new Error("Request text is required."), { code: "EMPTY_REQUEST" });

    // Smart continuation: if the user says "continue T3" from Muse/GrokBot, resume T3 cleanly!
    const existingContinue = pipeline.matchContinuationTarget(clean);
    if (existingContinue) {
      const resumed = pipeline.continueTask(existingContinue.id, { reply: clean, source: connector });
      onTaskQueued(resumed);
      return { continued: true, ...formatIntakeReceipt({ store, task: resumed }) };
    }

    const profile = getProfile();
    const projects = listAllProjects(profile);
    const matched = resolveProject(projectName || clean, projects);
    const task = store.createTask({
      text: clean,
      source: connector,
      sourceRef: idempotencyKey || null,
      projectName: matched?.name || null,
      projectPath: matched?.path || null,
      stakes: matched ? stakesForProject(matched, profile) : "standard",
      stage: "intake",
      status: "open",
    });
    onTaskQueued(task);
    return { created: true, ...formatIntakeReceipt({ store, task }) };
  }

  /** Relays an owner's answer from Muse or GrokBot back into the exact waiting OS thread. */
  function reply({ connector = "muse", taskId, text }) {
    const clean = String(text || "").trim();
    if (!clean) throw Object.assign(new Error("Reply text is required."), { code: "EMPTY_REPLY" });
    const task = store.getTask(taskId);
    if (!task) throw Object.assign(new Error(`Task "${taskId}" not found.`), { code: "TASK_MISSING" });
    if (task.stage === "waiting_approval") {
      throw Object.assign(new Error("Approvals must be tapped directly by the owner, not sent as text replies."), { code: "APPROVAL_REQUIRES_TAP" });
    }
    const resumed = pipeline.continueTask(task.id, { reply: clean, source: connector });
    onTaskQueued(resumed);
    return formatIntakeReceipt({ store, task: resumed });
  }

  /**
   * Lets Muse or GrokBot handle all upfront Q&A in its own conversation, then
   * drop a locked structured brief directly into the terminal Planner stage!
   */
  function submitBrief({ connector = "muse", idempotencyKey = null, brief }) {
    if (!brief || typeof brief !== "object" || typeof brief.summary !== "string" || !brief.summary.trim()) {
      throw Object.assign(new Error("A structured brief with a non-empty summary is required."), { code: "INVALID_BRIEF" });
    }
    const profile = getProfile();
    const projects = listAllProjects(profile);
    const matched = resolveProject(brief.project || brief.summary, projects);
    const stakes = matched ? stakesForProject(matched, profile) : "sandbox";

    const lockedBrief = {
      title: String(brief.title || brief.summary).trim().slice(0, 96),
      project: matched?.name || brief.project || null,
      newProject: matched ? null : (brief.newProject || null),
      complexity: ["trivial", "normal", "complex"].includes(brief.complexity) ? brief.complexity : "normal",
      summary: brief.summary.trim(),
      requirements: Array.isArray(brief.requirements) ? brief.requirements.slice(0, 25) : [],
      nonGoals: Array.isArray(brief.nonGoals) ? brief.nonGoals.slice(0, 15) : [],
      acceptanceChecks: Array.isArray(brief.acceptanceChecks) ? brief.acceptanceChecks.slice(0, 15) : [],
      verificationCommands: Array.isArray(brief.verificationCommands) ? brief.verificationCommands.slice(0, 8) : [],
      referenceFiles: Array.isArray(brief.referenceFiles) ? brief.referenceFiles.slice(0, 12) : [],
    };

    const task = store.createTask({
      title: lockedBrief.title,
      text: lockedBrief.summary,
      source: connector,
      sourceRef: idempotencyKey || null,
      projectName: matched?.name || null,
      projectPath: matched?.path || null,
      stakes,
      stage: "intake", // pipeline immediately skips intake Q&A because brief is populated!
      status: "open",
      brief: lockedBrief,
    });
    onTaskQueued(task);
    return formatIntakeReceipt({ store, task });
  }

  function status({ taskId }) {
    const task = store.getTask(taskId);
    if (!task) throw Object.assign(new Error(`Task "${taskId}" not found.`), { code: "TASK_MISSING" });
    return formatIntakeReceipt({ store, task });
  }

  return { submit, reply, submitBrief, status };
}

/** OpenAPI 3.1 schema for Muse (or any external assistant) exposing full bidirectional intake v2. */
function buildConnectorOpenApi(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const json = schema => ({ content: { "application/json": { schema } } });
  const receipt = { type: "object", properties: { task_id: { type: "string" }, stage: { type: "string" }, status: { type: "string" }, queue_paused: { type: "boolean" }, question: { type: "string" }, auth_required: { type: "object" }, delivery: { type: "object" } } };
  return {
    openapi: "3.1.0",
    info: {
      title: "AI-first OS Intake v2",
      version: "2.0.0",
      description: "Bidirectional intake for AI-first OS. Ask clarifying questions in your own chat, submit locked briefs, relay answers, and return sign-in links and Total Output cards. Hard-gated approvals still require a direct owner tap.",
    },
    servers: [{ url: base }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths: {
      "/api/v2/intake/submit": {
        post: {
          operationId: "submitRequest",
          summary: "Start a new request or continue an existing task.",
          requestBody: { required: true, ...json({ type: "object", required: ["text"], properties: { text: { type: "string" }, idempotencyKey: { type: "string" }, projectName: { type: "string" } } }) },
          responses: { 200: { description: "Receipt", ...json(receipt) } },
        },
      },
      "/api/v2/intake/reply": {
        post: {
          operationId: "replyToThread",
          summary: "Relay the owner's answer into an existing waiting thread.",
          requestBody: { required: true, ...json({ type: "object", required: ["taskId", "text"], properties: { taskId: { type: "string" }, text: { type: "string" } } }) },
          responses: { 200: { description: "Updated receipt", ...json(receipt) } },
        },
      },
      "/api/v2/intake/brief": {
        post: {
          operationId: "submitLockedBrief",
          summary: "Submit a locked requirements brief straight to the terminal Planner.",
          requestBody: { required: true, ...json({ type: "object", required: ["brief"], properties: { idempotencyKey: { type: "string" }, brief: { type: "object" } } }) },
          responses: { 200: { description: "Receipt", ...json(receipt) } },
        },
      },
      "/api/v2/intake/status": {
        post: {
          operationId: "getTaskStatus",
          summary: "Check live progress, questions, clickable sign-in links, and final Total Output.",
          requestBody: { required: true, ...json({ type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } }) },
          responses: { 200: { description: "Live receipt", ...json(receipt) } },
        },
      },
    },
  };
}

/** Detects local GrokBot installation & daemon state without leaking private credentials. */
function detectGrokBot({ homeDir = os.homedir(), profile = null } = {}) {
  const dataDir = profile?.connectors?.grokbot?.dataDir
    ? path.resolve(profile.connectors.grokbot.dataDir)
    : path.join(homeDir, ".grokbot");
  const daemonFile = path.join(dataDir, "local-exec-daemon.json");
  const connFile = path.join(dataDir, "local-exec-daemon-connection.json");
  const installed = fs.existsSync(dataDir);
  let daemonConfigured = false;
  if (fs.existsSync(daemonFile) || fs.existsSync(connFile)) daemonConfigured = true;
  return {
    id: "grokbot",
    label: "GrokBot",
    installed,
    daemonConfigured,
    dataDir: installed ? dataDir : null,
    enabled: profile?.connectors?.grokbot?.enabled === true,
  };
}

/**
 * Thin optional Google Sheet Sync view (replaces 53 KB of 3 overlapping Sheet modules).
 * SQLite stays the single source of truth; the Sheet is an optional mirror view.
 */
function createSheetSyncPlugin({ store, getProfile, callGoogleDrive = null }) {
  const HEADERS = ["ID", "Task", "Project", "Stakes", "Stage", "Status", "Agent", "Updated"];
  let lastHash = "";

  async function syncOnce() {
    const cfg = getProfile()?.connectors?.sheetsSync;
    if (!cfg?.enabled || !cfg.boardId || typeof callGoogleDrive !== "function") {
      return { synced: false, reason: "DISABLED" };
    }
    const rows = store.listTasks().map(t => [
      t.id,
      t.title,
      t.projectName || "",
      t.stakes,
      t.stage,
      t.status,
      t.assignedAgent || "",
      new Date(t.updatedAt).toISOString().slice(0, 10),
    ]);
    const fingerprint = JSON.stringify(rows);
    if (fingerprint === lastHash) return { synced: false, reason: "UNCHANGED", count: rows.length };

    const meta = await callGoogleDrive("get_spreadsheet_metadata", { spreadsheet_id: cfg.boardId });
    const tab = meta?.sheets?.find(s => s.properties?.title === "AIOS") || meta?.sheets?.[0];
    if (!Number.isInteger(tab?.properties?.sheetId)) return { synced: false, reason: "NO_TAB" };
    const values = [HEADERS, ...rows].map(row => ({
      values: row.map(v => ({ userEnteredValue: { stringValue: String(v ?? "") } })),
    }));
    await callGoogleDrive("batch_update_spreadsheet", {
      spreadsheet_id: cfg.boardId,
      requests: [{ updateCells: { start: { sheetId: tab.properties.sheetId, rowIndex: 0, columnIndex: 0 }, rows: values, fields: "userEnteredValue" } }],
    });
    lastHash = fingerprint;
    return { synced: true, count: rows.length };
  }

  return { syncOnce };
}

module.exports = {
  formatIntakeReceipt,
  createIntakeBridge,
  buildConnectorOpenApi,
  detectGrokBot,
  createSheetSyncPlugin,
};
