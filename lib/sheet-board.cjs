"use strict";

const { labelFor } = require("./harness-registry.cjs");

/**
 * The board as a real Google Sheet. The OS creates it, and keeps it current:
 * every task, who has it, its status and the latest note. The engine still
 * works from the local board file, so work never waits on Google. The Sheet is
 * the copy a person can open, read and share.
 */
// Laid out like a working agent task sheet: one Tasks tab, these ten columns, in this order.
const BOARD_TAB = "Tasks";
const OLDER_TAB = "Board";
const BOARD_HEADERS = Object.freeze(["ID", "Task", "To", "Status", "Latest note", "Order", "From", "Updated", "Created", "Spec file"]);
const STATUS_WORDS = Object.freeze({ Open: "Open", "In progress": "In progress", "Waiting on User": "Waiting on you", Done: "Done" });
const MAX_MIRROR_ROWS = 900;
const SYNC_MS = 20000;

const cell = value => ({ userEnteredValue: { stringValue: String(value ?? "") } });
const sheetUrl = boardId => `https://docs.google.com/spreadsheets/d/${boardId}/edit`;

/** The connector's reply shape is its own business. An ID or a Sheet link anywhere in it will do. */
function findSpreadsheetId(data, depth = 0) {
  if (depth > 6 || data === null || data === undefined) return null;
  if (typeof data === "string") {
    const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(data);
    return fromUrl ? fromUrl[1] : null;
  }
  if (typeof data !== "object") return null;
  for (const key of ["spreadsheet_id", "spreadsheetId", "file_id", "fileId", "id"]) {
    if (typeof data[key] === "string" && /^[A-Za-z0-9_-]{20,}$/.test(data[key])) return data[key];
  }
  for (const value of Object.values(data)) {
    const found = findSpreadsheetId(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function lastNote(note) {
  const lines = String(note || "").split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !/\[RUN P\d+ [0-9a-f]+ [0-9a-f]+\]/.test(line));
  const text = (lines.at(-1) || "").replace(/^\S+ \d{4}-\d{2}-\d{2}: /, "");
  return text.length > 300 ? text.slice(0, 297) + "…" : text;
}

/** One row per task, in plain words. Software-owned facts only. */
function boardValues(board) {
  return board.listTasks().slice(-MAX_MIRROR_ROWS).map(row => [
    row.ID,
    String(row.Task).replace(/\s+/g, " ").slice(0, 500),
    labelFor(row.To),
    STATUS_WORDS[row.Status] || row.Status,
    lastNote(row["Latest note"]),
    row.Order,
    labelFor(row.From),
    row.Updated,
    row.Created,
    row["Spec file"] === "none" ? "" : row["Spec file"],
  ]);
}

function headerRequest(sheetId) {
  return { updateCells: {
    start: { sheetId, rowIndex: 0, columnIndex: 0 },
    rows: [{ values: BOARD_HEADERS.map(cell) }],
    fields: "userEnteredValue",
  } };
}

/** Creates the owner's board Sheet in their own Google account. Returns where it lives. */
async function createBoardSheet({ call, title = "AI-first OS board" }) {
  const made = await call("create_file", { title, mime_type: "application/vnd.google-apps.spreadsheet" });
  const boardId = findSpreadsheetId(made);
  if (!boardId) throw Object.assign(new Error("Google did not say where the new Sheet is."), { code: "SHEET_CREATE" });
  const metadata = await call("get_spreadsheet_metadata", { spreadsheet_id: boardId });
  const first = metadata?.sheets?.[0]?.properties;
  if (!Number.isInteger(first?.sheetId)) throw Object.assign(new Error("The new Sheet could not be read."), { code: "SHEET_CREATE" });
  await call("batch_update_spreadsheet", { spreadsheet_id: boardId, requests: [
    { updateSheetProperties: {
      properties: { sheetId: first.sheetId, title: BOARD_TAB, gridProperties: { frozenRowCount: 1 } },
      fields: "title,gridProperties.frozenRowCount",
    } },
    headerRequest(first.sheetId),
  ] });
  return { boardId, url: sheetUrl(boardId), sheetId: first.sheetId };
}

/** Writes the board to the Sheet when, and only when, something changed. */
async function syncBoardSheet({ call, boardId, board, state = {} }) {
  const rows = boardValues(board);
  const fingerprint = JSON.stringify(rows);
  if (state.boardId === boardId && state.last === fingerprint) return { changed: false, rows: rows.length };
  if (state.boardId !== boardId || !Number.isInteger(state.sheetId)) {
    const metadata = await call("get_spreadsheet_metadata", { spreadsheet_id: boardId });
    const titled = name => metadata?.sheets?.find(sheet => sheet.properties?.title === name)?.properties;
    const tab = titled(BOARD_TAB) || titled(OLDER_TAB);
    if (!Number.isInteger(tab?.sheetId)) throw Object.assign(new Error("The Tasks tab is missing from the Sheet."), { code: "SHEET_BOARD_TAB" });
    Object.assign(state, { boardId, sheetId: tab.sheetId, rows: 0, last: null });
  }
  // Rows only ever grow, but blank out anything left over so the Sheet never shows a stale line.
  const leftover = Math.max(0, (state.rows || 0) - rows.length);
  const values = [BOARD_HEADERS, ...rows, ...Array.from({ length: leftover }, () => BOARD_HEADERS.map(() => ""))];
  await call("batch_update_spreadsheet", { spreadsheet_id: boardId, requests: [{ updateCells: {
    start: { sheetId: state.sheetId, rowIndex: 0, columnIndex: 0 },
    rows: values.map(row => ({ values: row.map(cell) })),
    fields: "userEnteredValue",
  } }] });
  state.last = fingerprint;
  state.rows = rows.length;
  return { changed: true, rows: rows.length };
}

/** Is this the Sheet the OS made and keeps current (as opposed to one the owner captures tasks into)? */
function mirrorTarget(manifest) {
  const sheets = manifest?.board?.sheets;
  return sheets?.provider === "codex" && sheets.mirror === true && typeof sheets.boardId === "string" && sheets.boardId
    ? sheets.boardId : null;
}

/** Keeps the Sheet current in the background. A Google outage never stops the work. */
function startSheetMirror({ board, manifest, call, intervalMs = SYNC_MS, onError = () => {} }) {
  const state = {};
  let running = false;
  async function sync() {
    const boardId = mirrorTarget(manifest);
    if (!boardId || running) return { changed: false };
    running = true;
    try {
      return await syncBoardSheet({ call, boardId, board, state });
    } catch (error) {
      onError(error);
      return { changed: false, error };
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => { sync(); }, intervalMs);
  timer.unref?.();
  sync();
  return { sync, stop: () => clearInterval(timer) };
}

module.exports = { BOARD_TAB, BOARD_HEADERS, createBoardSheet, syncBoardSheet, startSheetMirror, mirrorTarget, boardValues, findSpreadsheetId, sheetUrl };
