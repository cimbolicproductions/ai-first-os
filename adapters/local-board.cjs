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
function createLocalBoard({ boardDir, routerName = "Router", now = () => new Date() }) {
  const root = path.resolve(boardDir);
  const jsonPath = path.join(root, "board.json");
  const mdPath = path.join(root, "BOARD.md");

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

  function initBoard(starterRows = []) {
    fs.mkdirSync(root, { recursive: true });
    if (fs.existsSync(jsonPath)) return readState();
    const initial = {
      version: 1,
      headers: HEADERS,
      rows: starterRows.length
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
    fs.renameSync(tmp, jsonPath);
    fs.writeFileSync(mdPath, renderMarkdown(state), "utf8");
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

  function addTask({ id, task, to = "claude", from = routerName, order, specFile = "none", note }) {
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
    saveState(state);
    return structuredClone(newRow);
  }

  function findTask(id) {
    const state = readState();
    const matches = state.rows.filter(r => r.ID === id);
    if (matches.length > 1) throw Object.assign(new Error(`Duplicate task ID: ${id}`), { code: "ID_COLLISION" });
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  function claimTask({ taskId, agent, runId = crypto.randomBytes(4).toString("hex"), claimCode = crypto.randomBytes(6).toString("hex") }) {
    const state = readState();
    const row = state.rows.find(r => r.ID === taskId);
    if (!row) throw Object.assign(new Error("Task missing"), { code: "TASK_MISSING" });
    if (row.Status === "Done") throw Object.assign(new Error("Task already done"), { code: "TASK_DONE" });
    if (row.To.toLowerCase() !== String(agent).toLowerCase()) {
      throw Object.assign(new Error(`Row ${taskId} is assigned to ${row.To}, not ${agent}`), { code: "NOT_OWNER" });
    }
    const marker = `[RUN ${taskId} ${runId} ${claimCode}]`;
    const stamp = todayStr();
    row.Status = "In progress";
    row.Updated = stamp;
    row["Latest note"] = `${row["Latest note"] ? row["Latest note"] + "\n" : ""}${agent} ${stamp}: ${marker}`;
    saveState(state);
    return { task: structuredClone(row), claimMarker: marker };
  }

  function updateByColumnName({ taskId, agent, claimMarker, columns = {}, note }) {
    const state = readState();
    const row = state.rows.find(r => r.ID === taskId);
    if (!row) throw Object.assign(new Error("Task missing"), { code: "TASK_MISSING" });
    if (claimMarker && !String(row["Latest note"] || "").includes(claimMarker)) {
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
  };
}

module.exports = { HEADERS, STATUSES, createLocalBoard };
