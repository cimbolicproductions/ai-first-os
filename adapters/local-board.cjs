"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HEADERS = ["ID", "Task", "To", "Status", "Latest note", "Order", "From", "Updated", "Created", "Spec file"];
const STATUSES = new Set(["Open", "In progress", "Waiting on User", "Waiting on Dom", "Done"]);

/**
 * Local file-backed Task Board (JSON state + rendered Markdown table) implementing
 * the exact same protocol as the Google Sheets board:
 * - Write by column name, never position
 * - One owner per row, claim first with [RUN <id> <runId> <claimCode>]
 * - Atomic temp-file write + readback verification
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createLocalBoard({ boardDir, routerName = "Router", now = () => new Date() }) {
  const root = path.resolve(boardDir);
  const jsonPath = path.join(root, "board.json");
  const mdPath = path.join(root, "BOARD.md");
  const lockPath = path.join(root, "board.lock");
  const activityPath = path.join(root, "activity.jsonl");

  /** The service, desktop and terminal all write here; one writer at a time. */
  function withLock(fn) {
    fs.mkdirSync(root, { recursive: true });
    const deadline = Date.now() + 10000;
    let held = false;
    while (!held) {
      try {
        fs.closeSync(fs.openSync(lockPath, "wx"));
        held = true;
      } catch (err) {
        if (err.code !== "EEXIST" && err.code !== "EPERM") throw err;
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 15000) fs.rmSync(lockPath, { force: true });
        } catch {
          // The holder released it between the two calls.
        }
        if (Date.now() > deadline) {
          throw Object.assign(new Error("The board is busy. Try again in a moment."), { code: "BOARD_BUSY" });
        }
        sleepSync(15);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  }

  function logActivity(entry) {
    fs.appendFileSync(activityPath, JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + "\n", "utf8");
  }

  function listActivity() {
    if (!fs.existsSync(activityPath)) return [];
    return fs
      .readFileSync(activityPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }

  function renameWithRetry(from, to) {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(from, to);
        return;
      } catch (err) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(err.code) || attempt >= 8) throw err;
        sleepSync(25 * (attempt + 1));
      }
    }
  }

  function todayStr() {
    return new Date(now()).toISOString().slice(0, 10);
  }

  function renderMarkdown(state) {
    const lines = [
      `# AI-first OS Task Board (Local Mode)`,
      ``,
      `Router: **${routerName}** | Canonical file: \`board.json\``,
      ``,
      `| ${HEADERS.join(" | ")} |`,
      `| ${HEADERS.map(() => "---").join(" | ")} |`,
    ];
    for (const row of state.rows) {
      const cells = HEADERS.map(h => String(row[h] ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"));
      lines.push(`| ${cells.join(" | ")} |`);
    }
    return lines.join("\n") + "\n";
  }

  function initBoard(starterRows = [], { empty = false } = {}) {
    fs.mkdirSync(root, { recursive: true });
    if (fs.existsSync(jsonPath)) return readState();
    const initial = {
      version: 1,
      headers: HEADERS,
      meta: {},
      rows: starterRows.length || empty
        ? starterRows
        : [
            {
              ID: "P1",
              Task: "Verify AI-first OS setup and run doctor check",
              To: "claude",
              Status: "Open",
              "Latest note": `${routerName} ${todayStr()}: Initial onboarding task.`,
              Order: "1",
              From: routerName,
              Updated: todayStr(),
              Created: todayStr(),
              "Spec file": "none",
            },
          ],
    };
    saveState(initial);
    return initial;
  }

  function readState() {
    if (!fs.existsSync(jsonPath)) return initBoard();
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (JSON.stringify(data.headers) !== JSON.stringify(HEADERS)) {
      throw Object.assign(new Error("Board headers differ from contract"), { code: "HEADERS_CHANGED" });
    }
    return data;
  }

  function saveState(state) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = `${jsonPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameWithRetry(tmp, jsonPath);
    fs.writeFileSync(mdPath, renderMarkdown(state), "utf8");
  }

  /** Software-owned facts about a row. Never set from board prose. */
  function getMeta(id) {
    return structuredClone(readState().meta?.[id] || {});
  }

  function setMeta(id, patch) {
    return withLock(() => {
      const state = readState();
      state.meta = state.meta || {};
      state.meta[id] = { ...(state.meta[id] || {}), ...patch };
      saveState(state);
      return structuredClone(state.meta[id]);
    });
  }

  function listTasks({ status, to } = {}) {
    const state = readState();
    return state.rows
      .filter(r => {
        if (status && r.Status.toLowerCase() !== String(status).toLowerCase()) return false;
        if (to && r.To.toLowerCase() !== String(to).toLowerCase()) return false;
        return true;
      })
      .map(r => structuredClone(r));
  }

  function addTask(input) {
    return withLock(() => addTaskLocked(input));
  }

  function addTaskLocked({ id, task, to = "claude", from = routerName, order, specFile = "none", note, meta = null }) {
    if (!task || !String(task).trim()) {
      throw Object.assign(new Error("Task description is required"), { code: "INVALID_TASK" });
    }
    const state = readState();
    const nextNum = state.rows.length + 1;
    const taskId = id || `P${nextNum}`;
    if (state.rows.some(r => r.ID === taskId)) {
      throw Object.assign(new Error(`Task ID already exists: ${taskId}`), { code: "ID_COLLISION" });
    }
    const stamp = todayStr();
    const newRow = {
      ID: taskId,
      Task: String(task).trim(),
      To: String(to).trim(),
      Status: "Open",
      "Latest note": `${from} ${stamp}: ${note || "Queued on task board."}`,
      Order: String(order ?? nextNum),
      From: String(from).trim(),
      Updated: stamp,
      Created: stamp,
      "Spec file": String(specFile || "none"),
    };
    state.rows.push(newRow);
    if (meta) {
      state.meta = state.meta || {};
      state.meta[taskId] = meta;
    }
    saveState(state);
    logActivity({ type: "queued", row: taskId, to: newRow.To, task: newRow.Task });
    return structuredClone(newRow);
  }

  function findTask(id) {
    const state = readState();
    const matches = state.rows.filter(r => r.ID === id);
    if (matches.length > 1) throw Object.assign(new Error(`Duplicate task ID: ${id}`), { code: "ID_COLLISION" });
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  function claimTask(input) {
    return withLock(() => claimTaskLocked(input));
  }

  function claimTaskLocked({ taskId, agent, assignTo = agent, meta, note, runId = crypto.randomBytes(4).toString("hex"), claimCode = crypto.randomBytes(6).toString("hex") }) {
    const state = readState();
    const row = state.rows.find(r => r.ID === taskId);
    if (!row) throw Object.assign(new Error("Task missing"), { code: "TASK_MISSING" });
    if (row.Status === "Done") throw Object.assign(new Error("Task already done"), { code: "TASK_DONE" });
    if (row.Status === "In progress") throw Object.assign(new Error(`${taskId} is already running.`), { code: "TASK_BUSY" });
    if (row.Status !== "Open") throw Object.assign(new Error("Answer the pending question first."), { code: "TASK_NOT_OPEN" });
    if (row.To.toLowerCase() !== String(agent).toLowerCase()) {
      throw Object.assign(new Error(`Row ${taskId} is assigned to ${row.To}, not ${agent}`), { code: "NOT_OWNER" });
    }
    const marker = `[RUN ${taskId} ${runId} ${claimCode}]`;
    const stamp = todayStr();
    state.meta = state.meta || {};
    state.meta[taskId] = { ...state.meta[taskId], ...meta, activeClaim: marker };
    row.Status = "In progress";
    row.To = assignTo;
    row.Updated = stamp;
    const notes = [row["Latest note"]];
    if (note) notes.push(`${agent} ${stamp}: ${note}`);
    notes.push(`${assignTo} ${stamp}: ${marker}`);
    row["Latest note"] = notes.filter(Boolean).join("\n");
    saveState(state);
    logActivity({ type: "started", row: taskId, to: assignTo, task: row.Task });
    return { task: structuredClone(row), claimMarker: marker };
  }

  function updateByColumnName(input) {
    return withLock(() => updateByColumnNameLocked(input));
  }

  function updateByColumnNameLocked({ taskId, agent, claimMarker, columns = {}, note, meta }) {
    const state = readState();
    const row = state.rows.find(r => r.ID === taskId);
    if (!row) throw Object.assign(new Error("Task missing"), { code: "TASK_MISSING" });
    if (claimMarker && (row.Status !== "In progress" || state.meta?.[taskId]?.activeClaim !== claimMarker)) {
      throw Object.assign(new Error("Missing or mismatched claim marker"), { code: "CLAIM_MISMATCH" });
    }
    for (const key of Object.keys(columns)) {
      if (!HEADERS.includes(key) || key === "ID" || key === "Created") {
        throw Object.assign(new Error(`Column "${key}" cannot be modified`), { code: "INVALID_COLUMN" });
      }
      if (key === "Status" && !STATUSES.has(columns[key])) {
        throw Object.assign(new Error(`Invalid status "${columns[key]}"`), { code: "INVALID_STATUS" });
      }
      row[key] = String(columns[key]);
    }
    if (meta || columns.Status) {
      state.meta = state.meta || {};
      state.meta[taskId] = { ...state.meta[taskId], ...meta };
      if (columns.Status && columns.Status !== "In progress") delete state.meta[taskId].activeClaim;
    }
    const stamp = todayStr();
    if (note) {
      const prefixed = String(note)
        .split(/\r?\n/)
        .map(line => `${agent} ${stamp}: ${line}`)
        .join("\n");
      row["Latest note"] = `${row["Latest note"] ? row["Latest note"] + "\n" : ""}${prefixed}`;
    }
    row.Updated = stamp;
    saveState(state);
    if (columns.Status) logActivity({ type: columns.Status, row: taskId, to: agent, task: row.Task });
    return structuredClone(row);
  }

  return {
    HEADERS,
    jsonPath,
    mdPath,
    initBoard,
    listTasks,
    addTask,
    findTask,
    claimTask,
    updateByColumnName,
    getMeta,
    setMeta,
    listActivity,
    logActivity,
  };
}

module.exports = { HEADERS, STATUSES, createLocalBoard };
