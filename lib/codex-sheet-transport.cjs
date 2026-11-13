"use strict";

const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { locateBinary } = require("./agent-auth.cjs");
const { findHarness, buildSpawnPlan, stopProcessTree } = require("./harness-registry.cjs");

const TIMEOUT_MS = 30000;
const IDLE_MS = 8000;
let connection;
let idle;
let active = 0;

function unavailable(code = "SHEET_CONNECTION") {
  return Object.assign(new Error("I couldn’t reach your Google Sheet. Check Google Drive in your signed-in Codex account and try again."), { code });
}

function openServer() {
  const codex = locateBinary(findHarness("codex").worker.binaries);
  if (!codex) throw unavailable("CODEX_MISSING");
  const plan = buildSpawnPlan(codex, ["app-server", "--stdio"]);
  const child = spawn(plan.file, plan.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...plan.options });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  child.stderr.resume();

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(unavailable());
    }
    pending.clear();
    lines.close();
    child.stdin.end();
    stopProcessTree(child);
  }

  const write = message => child.stdin.write(JSON.stringify(message) + "\n");
  function request(method, params) {
    if (closed) return Promise.reject(unavailable());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(unavailable("SHEET_TIMEOUT")); close(); }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  }

  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      write({ id: message.id, error: { code: -32601, message: "Interactive requests are unavailable." } });
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(unavailable("SHEET_CONNECTOR_RPC"));
    else entry.resolve(message.result);
  });
  child.once("error", close);
  child.once("close", close);
  child.stdin.on("error", close);

  const ready = (async () => {
    await request("initialize", { clientInfo: { name: "ai-first-os", version: "1.0" }, capabilities: { experimentalApi: true } });
    write({ method: "initialized" });
    const result = await request("thread/start", { ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
    if (!result?.thread?.id || result.thread.path !== null) throw unavailable("SHEET_CONTEXT");
    return result.thread.id;
  })().catch(error => { close(); throw error; });
  return { ready, request, close, isClosed: () => closed };
}

async function callGoogleDrive(tool, args) {
  clearTimeout(idle);
  if (!connection || connection.isClosed()) connection = openServer();
  const server = connection;
  active++;
  try {
    const threadId = await server.ready;
    const result = await server.request("mcpServer/tool/call", {
      threadId, server: "codex_apps", tool: "google_drive." + tool, arguments: args,
    });
    const data = result?.structuredContent;
    if (result?.isError || !data || data.error || data.error_code) throw unavailable("SHEET_CONNECTOR_TOOL");
    return data;
  } finally {
    active--;
    if (!active) {
      idle = setTimeout(() => server.close(), IDLE_MS);
      idle.unref();
    }
  }
}

const valueCell = stringValue => ({ userEnteredValue: { stringValue } });

function createCodexSheetTransport({ boardId }, call = callGoogleDrive) {
  const request = (tool, args) => call(tool, { spreadsheet_id: boardId, ...args });
  const batch = requests => request("batch_update_spreadsheet", { requests });
  return {
    getMetadata: () => request("get_spreadsheet_metadata", {}),
    async readRange(sheet_name, range) {
      const data = await request("get_spreadsheet_range", { sheet_name, range });
      if (!Array.isArray(data.values)) {
        if (data.range && data.majorDimension === "ROWS" && (data.values === undefined || data.values === null)) return [];
        throw unavailable("SHEET_RESPONSE");
      }
      return data.values;
    },
    appendRows: (sheetId, rows) => batch([{ appendCells: {
      sheetId, rows: rows.map(row => ({ values: row.map(valueCell) })), fields: "userEnteredValue",
    } }]),
    updateCells: (sheetId, rowIndex, cells) => batch(cells.map(({ column, value }) => ({ updateCells: {
      range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: column, endColumnIndex: column + 1 },
      rows: [{ values: [valueCell(value)] }], fields: "userEnteredValue",
    } }))),
  };
}

module.exports = { createCodexSheetTransport, callGoogleDrive };
