"use strict";

const crypto = require("node:crypto");
const { createOwnerSheetTransport } = require("../adapters/sheets-board.cjs");

const HEADERS = ["ID", "Task", "To", "Status", "Latest note", "Order", "From", "Updated", "Created", "Spec file"];
const STATUSES = new Set(["Open", "In progress", "Waiting on Dom", "Done"]);
const MAX_ROWS = 20000;
const PAGE_ROWS = 500;
const MAX_TASKS = 20;
const MAX_TASK_CHARS = 4000;
const writes = new Map();
const unconfirmed = new Map();

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function dateInZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return [date.year, date.month, date.day].join("-");
}

function columnName(number) {
  let name = "";
  for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function taskText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TASK_CHARS) {
    fail("SHEET_INVALID_REQUEST", "Enter task text up to 4,000 characters.");
  }
  return value.trim();
}

function validateRequestId(requestId) {
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) {
    fail("SHEET_INVALID_REQUEST", "This change needs a valid request ID.");
  }
}

function serial(boardId, operation) {
  const next = (writes.get(boardId) || Promise.resolve()).then(operation);
  const tail = next.catch(() => {});
  writes.set(boardId, tail);
  return next.finally(() => {
    if (writes.get(boardId) === tail) writes.delete(boardId);
  });
}

function taskAt(tab, values, index) {
  const raw = HEADERS.map(name => String(values[tab.columns.get(name)] ?? ""));
  const [id, task, to, status, note, order, from, updated, created, specFile] = raw;
  return {
    tab: tab.name,
    rowIndex: index,
    value: { id, task, to, status, note, order, from, updated, created, specFile, revision: hash(raw) },
  };
}

function openTask(row) {
  return row.value.id && row.value.task && STATUSES.has(row.value.status) && row.value.status !== "Done";
}

function taskNumber(id) {
  return /^P[1-9][0-9]*$/.test(id) ? Number(id.slice(1)) : 0;
}

function receiptPattern(requestId) {
  return new RegExp("\\[AIOS " + requestId + " ([0-9a-f]{24}) (\\d+)/(\\d+)\\]", "g");
}

function defaultTransport(config) {
  if (config.provider === "codex") {
    return require("./codex-sheet-transport.cjs").createCodexSheetTransport(config);
  }
  return createOwnerSheetTransport({ boardId: config.boardId, serviceAccountPath: config.serviceAccountPath });
}

/** Owner-facing app storage. Agent tools keep their own restricted write surface. */
function createSheetTasks({ manifest, makeTransport = defaultTransport, now = () => new Date() } = {}) {
  const config = manifest?.board?.sheets;
  const configured = Boolean(config?.boardId && (config.provider === "codex" || config.serviceAccountPath));
  let transport;
  const boardId = config?.boardId;
  const owner = String(config?.ownerName || "Owner").trim() || "Owner";
  const assignee = String(config?.assignee || owner).trim() || owner;

  function client() {
    if (!configured) fail("SHEET_NOT_CONNECTED", "Connect your Google Sheet to see or save tasks.");
    if (!transport) transport = makeTransport(config);
    return transport;
  }

  async function describeTab(metadata, name) {
    const properties = metadata.sheets?.find(sheet => sheet.properties?.title === name)?.properties;
    const rowCount = properties?.gridProperties?.rowCount;
    const colCount = properties?.gridProperties?.columnCount;
    if (!Number.isInteger(properties?.sheetId) || !Number.isInteger(rowCount) || rowCount < 1 ||
        !Number.isInteger(colCount) || colCount < HEADERS.length || rowCount > MAX_ROWS) {
      fail("SHEET_HEADERS", "The task sheet tabs or grid size could not be verified.");
    }
    const width = Math.min(26, colCount);
    const columns = await readHeaders(name, width);
    return { name, id: properties.sheetId, rowCount, headerWidth: width, columns, width: Math.max(...columns.values()) + 1 };
  }

  async function readHeaders(name, width) {
    const [headers] = await client().readRange(name, "A1:" + columnName(width) + "1");
    const columns = new Map(HEADERS.map(key => [key, headers?.indexOf(key) ?? -1]));
    if (HEADERS.some(key => columns.get(key) < 0 || headers.lastIndexOf(key) !== columns.get(key))) {
      fail("SHEET_HEADERS", "The " + name + " tab must use the Agent Tasks column names.");
    }
    return columns;
  }

  async function readRows(tab) {
    const rows = [];
    for (let first = 2; first <= tab.rowCount; first += PAGE_ROWS) {
      const last = Math.min(first + PAGE_ROWS - 1, tab.rowCount);
      const values = await client().readRange(tab.name, "A" + first + ":" + columnName(tab.width) + last);
      if (!Array.isArray(values)) fail("SHEET_HEADERS", "Could not read the task rows.");
      values.forEach((row, offset) => {
        if (Array.isArray(row) && row.some(value => value !== "" && value !== null)) rows.push(taskAt(tab, row, first + offset - 1));
      });
    }
    return rows;
  }

  async function snapshot(includeDone = false) {
    const metadata = await client().getMetadata();
    if (!Array.isArray(metadata?.sheets)) fail("SHEET_HEADERS", "The Google Sheet could not be verified.");
    const tasks = await describeTab(metadata, "Tasks");
    const done = includeDone ? await describeTab(metadata, "Done") : null;
    const [active, archived] = await Promise.all([readRows(tasks), done ? readRows(done) : []]);
    return { tasks, active, all: [...active, ...archived], timeZone: metadata.properties?.timeZone || "UTC" };
  }

  function matchingReceipt(rows, requestId, fingerprint, expectedCount) {
    const result = [];
    for (const row of rows) {
      for (const match of row.value.note.matchAll(receiptPattern(requestId))) {
        const index = Number(match[2]) - 1;
        if (match[1] !== fingerprint || Number(match[3]) !== expectedCount || index < 0 || index >= expectedCount || result[index]) {
          fail("SHEET_CONFLICT", "That request ID is already attached to a different change. Refresh the task list.");
        }
        if (rows.filter(item => item.value.id === row.value.id).length !== 1) {
          fail("SHEET_ID_COLLISION", "Two rows share " + row.value.id + ". Check the sheet before editing either row.");
        }
        result[index] = row.value;
      }
    }
    if (!result.length) return null;
    if (result.filter(Boolean).length !== expectedCount) {
      fail("SHEET_UNCONFIRMED", "Only part of this save could be confirmed. Keep this request and check the sheet.");
    }
    return result;
  }

  function receipt(requestId, fingerprint, index, count) {
    return "[AIOS " + requestId + " " + fingerprint + " " + index + "/" + count + "]";
  }

  function operationKey(requestId) {
    return boardId + ":" + requestId;
  }

  function deferUnconfirmed() {
    fail("SHEET_UNCONFIRMED", "Google Sheets did not confirm the save. Keep this request and try again to check its status.");
  }

  function ensureRetrySafe(key, fingerprint) {
    if (!unconfirmed.has(key)) return;
    if (unconfirmed.get(key) !== fingerprint) {
      fail("SHEET_CONFLICT", "This request ID already belongs to another save.");
    }
    deferUnconfirmed();
  }

  async function confirmWrite({ requestId, fingerprint, count, write }) {
    const key = operationKey(requestId);
    ensureRetrySafe(key, fingerprint);
    unconfirmed.set(key, fingerprint);
    try {
      await write();
    } catch (error) {
      // Only retry after a known rejection. A network loss can hide a committed write.
      if (error.code === "AUTH_ERROR" || error.code === "INVALID_CREDENTIALS" ||
          error.code === "CONFIG_REQUIRED" ||
          (error.code === "SHEETS_HTTP_ERROR" && /^Google API (?:400|401|403|404):/.test(error.message))) {
        unconfirmed.delete(key);
        throw error;
      }
    }
    let result;
    try {
      result = matchingReceipt((await snapshot(true)).all, requestId, fingerprint, count);
    } catch (error) {
      if (error.code === "SHEET_ID_COLLISION" || error.code === "SHEET_CONFLICT") throw error;
      deferUnconfirmed();
    }
    if (!result) deferUnconfirmed();
    unconfirmed.delete(key);
    return result;
  }

  async function listOpen() {
    const state = await snapshot();
    return state.active.filter(openTask).map(row => row.value);
  }

  async function add({ tasks, requestId, source } = {}) {
    validateRequestId(requestId);
    if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_TASKS) {
      fail("SHEET_INVALID_REQUEST", "Save between one and 20 tasks at a time.");
    }
    const titles = tasks.map(taskText);
    const fingerprint = hash(["add", titles]);
    client();
    return serial(boardId, async () => {
      const state = await snapshot(true);
      const existing = matchingReceipt(state.all, requestId, fingerprint, titles.length);
      if (existing) {
        unconfirmed.delete(operationKey(requestId));
        return existing;
      }
      ensureRetrySafe(operationKey(requestId), fingerprint);
      const maxId = Math.max(0, ...state.all.map(row => taskNumber(row.value.id)));
      const maxOrder = Math.max(0, ...state.active.filter(row => row.value.to === assignee && openTask(row))
        .map(row => Number(row.value.order)).filter(Number.isSafeInteger));
      if (!Number.isSafeInteger(maxId + titles.length) || !Number.isSafeInteger(maxOrder + titles.length)) {
        fail("SHEET_ID_COLLISION", "A task ID is outside the supported range. Check the sheet.");
      }
      const date = dateInZone(now(), state.timeZone);
      const rows = titles.map((title, index) => {
        const row = Array(state.tasks.width).fill("");
        const note = owner + " " + date + ": Captured " + (source === "phone" ? "on the phone. " : "on the computer. ") +
          receipt(requestId, fingerprint, index + 1, titles.length);
        const values = ["P" + (maxId + index + 1), title, assignee, "Open", note, String(maxOrder + index + 1), owner, date, date, "none"];
        HEADERS.forEach((name, i) => { row[state.tasks.columns.get(name)] = values[i]; });
        return row;
      });
      return confirmWrite({
        requestId, fingerprint, count: titles.length,
        write: () => client().appendRows(state.tasks.id, rows),
      });
    });
  }

  async function update({ id, task, status, requestId, revision, source } = {}) {
    validateRequestId(requestId);
    if (!/^P[1-9][0-9]*$/.test(id || "") || typeof revision !== "string" || !/^[0-9a-f]{24}$/.test(revision) ||
        (task === undefined && status === undefined) || (status !== undefined && !STATUSES.has(status))) {
      fail("SHEET_INVALID_REQUEST", "Select a task and enter a valid change.");
    }
    const title = task === undefined ? undefined : taskText(task);
    const fingerprint = hash(["update", id, title, status]);
    client();
    return serial(boardId, async () => {
      const state = await snapshot(true);
      const existing = matchingReceipt(state.all, requestId, fingerprint, 1);
      if (existing) {
        if (existing[0].id !== id) fail("SHEET_CONFLICT", "The save receipt belongs to a different task. Check the sheet.");
        unconfirmed.delete(operationKey(requestId));
        return existing[0];
      }
      ensureRetrySafe(operationKey(requestId), fingerprint);
      const matches = state.all.filter(row => row.value.id === id);
      if (matches.length > 1) fail("SHEET_ID_COLLISION", "Two rows share " + id + ". Check the sheet before editing either row.");
      const target = matches[0];
      if (!target || target.tab !== "Tasks") fail("SHEET_TASK_MISSING", "That task is no longer on the Tasks tab.");
      if (target.value.revision !== revision) fail("SHEET_CONFLICT", "That task changed. Refresh the task list before editing.");
      const { tasks } = state;
      const [liveColumns, liveRows] = await Promise.all([
        readHeaders("Tasks", tasks.headerWidth),
        client().readRange("Tasks", "A" + (target.rowIndex + 1) + ":" + columnName(tasks.width) + (target.rowIndex + 1)),
      ]);
      const live = liveRows[0] && taskAt({ ...tasks, columns: liveColumns }, liveRows[0], target.rowIndex).value;
      if (!live || live.id !== id || live.revision !== revision ||
          HEADERS.some(key => tasks.columns.get(key) !== liveColumns.get(key))) {
        fail("SHEET_CONFLICT", "That task moved or changed. Refresh the task list before editing.");
      }
      const date = dateInZone(now(), state.timeZone);
      const note = owner + " " + date + ": Updated " + (source === "phone" ? "on the phone. " : "on the computer. ") +
        receipt(requestId, fingerprint, 1, 1);
      const changes = [
        ["Latest note", [live.note, note].filter(Boolean).join("\n")],
        ["Updated", date],
        ...(title === undefined ? [] : [["Task", title]]),
        ...(status === undefined ? [] : [["Status", status]]),
      ];
      const cells = changes.map(([name, value]) => ({ column: tasks.columns.get(name), value }));
      const result = await confirmWrite({
        requestId, fingerprint, count: 1,
        write: () => client().updateCells(tasks.id, target.rowIndex, cells),
      });
      if (result[0].id !== id || (title !== undefined && result[0].task !== title) ||
          (status !== undefined && result[0].status !== status)) {
        fail("SHEET_CONFLICT", "The task changed while it was being saved. Check the sheet.");
      }
      return result[0];
    });
  }

  return { configured, listOpen, add, update };
}

module.exports = { createSheetTasks };
