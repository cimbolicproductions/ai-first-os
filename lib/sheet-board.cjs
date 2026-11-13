"use strict";

const { labelFor } = require("./harness-registry.cjs");

/**
 * The board as a real Google Sheet. The OS creates it, and keeps it current:
 * every task, who has it, its status and the latest note. The engine still
 * works from the local board file, so work never waits on Google. The Sheet is
 * the copy a person can open, read and share.
 *
 * Three things a person does in the Sheet come back to the board: a new line
 * typed at the bottom becomes a request, a Status set to Done or Open is applied,
 * and a note typed on a finished build goes into its next version. Everything
 * else in the Sheet is the software's own writing and is simply written again.
 */
// Laid out like a working agent task sheet: one Tasks tab, these ten columns, in this order.
const BOARD_TAB = "Tasks";
const OLDER_TAB = "Board";
const BOARD_HEADERS = Object.freeze(["ID", "Task", "To", "Status", "Latest note", "Order", "From", "Updated", "Created", "Spec file"]);
const STATUS_WORDS = Object.freeze({ Open: "Open", "In progress": "In progress", "Waiting on User": "Waiting on you", Done: "Done" });
const MAX_MIRROR_ROWS = 900;
const SYNC_MS = 20000;
/** How often the Sheet is read for a person's edits. Reading is slower than writing, so it is done less often. */
const READ_BACK_MS = 60000;
const COLUMN = Object.freeze(Object.fromEntries(BOARD_HEADERS.map((name, index) => [name, index])));
const STATUS_FROM_SHEET = Object.freeze({ done: "Done", open: "Open" });

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

const cellText = value => String(value ?? "").replace(/\s+/g, " ").trim();

/** Whether something read from the Sheet has already been applied, according to the board's own record. */
function alreadyTaken(board, receipt) {
  return board.listTasks().some(row => {
    const meta = board.getMeta(row.ID);
    return meta.sheetReceipt === receipt || (meta.sheetNotes || []).includes(receipt);
  });
}

/** Words that order something only the owner may approve. */
function gated(text) {
  const { ordersGatedAction, classifyOrganizerRequest } = require("./request-flow.cjs");
  return ordersGatedAction(text) || classifyOrganizerRequest(text) === "external_action";
}

/**
 * Reads what a person changed in the Sheet and applies it to the board. Only a
 * cell that differs from what the software last wrote there counts as theirs, and
 * the board wins whenever it has moved on since. Returns how many things came back.
 */
async function readBackSheet({ call, boardId, board, state, manifest, queue, addNote }) {
  const data = await call("get_spreadsheet_range", { spreadsheet_id: boardId, sheet_name: state.tabTitle, range: `A1:J${(state.rows || 0) + 60}` });
  const values = Array.isArray(data?.values) ? data.values : [];
  const written = state.written || null;
  const router = manifest?.ideology?.routerFunnel || "Router";
  let taken = 0;
  let extra = 0;
  for (let index = 1; index < values.length; index++) {
    const line = BOARD_HEADERS.map((_, column) => cellText(values[index]?.[column]));
    if (!line.some(Boolean)) continue;
    extra = Math.max(extra, index);
    const id = line[COLUMN.ID];
    const local = /^P[1-9]\d*$/.test(id) ? board.findTask(id) : null;
    if (!local) {
      // A line the software never wrote: a person typed a task. It becomes a request like any other.
      const task = line[COLUMN.Task];
      if (id || !task || task.length > 4000) continue;
      // The receipt is kept on the board itself, against this line of the Sheet. If the write back
      // did not land, or the app restarted, the same line is still there and is not taken again.
      const receipt = `line ${index}: ${task}`;
      if (alreadyTaken(board, receipt)) continue;
      try {
        const made = queue({ task, board, manifest, source: "sheet" });
        board.setMeta(made.ID, { sheetReceipt: receipt });
        taken++;
      } catch { /* an unusable line is left for the person to fix, and tried again next time */ }
      continue;
    }
    const before = written?.[index - 1];
    if (!before || before[COLUMN.ID] !== id) continue;
    // Status: only Done and Open are taken, and only while the board still says what the Sheet was last told.
    const wanted = STATUS_FROM_SHEET[line[COLUMN.Status].toLowerCase()];
    const shown = STATUS_WORDS[local.Status] || local.Status;
    if (wanted && line[COLUMN.Status] !== cellText(before[COLUMN.Status]) && shown === before[COLUMN.Status] && wanted !== local.Status && local.Status !== "In progress") {
      try {
        board.updateByColumnName({ taskId: id, agent: router, columns: { Status: wanted }, note: `Marked ${wanted.toLowerCase()} in the Sheet.` });
        taken++;
      } catch { /* the board moved on first, so the board stands */ }
    }
    // A note typed over the latest note on a finished build is a note for its next version.
    const note = line[COLUMN["Latest note"]];
    if (note && note !== cellText(before[COLUMN["Latest note"]]) && note.length <= 4000) {
      const receipt = `note on ${id}: ${note}`;
      if (alreadyTaken(board, receipt)) continue;
      // Other people may be able to edit the Sheet. A note that tells an agent to send, publish
      // or spend is not passed to a builder as the owner's word: it becomes a request, and the
      // organizer holds it for a yes like any other.
      if (gated(note)) {
        try {
          const made = queue({ task: note, board, manifest, source: "sheet" });
          board.setMeta(made.ID, { sheetReceipt: receipt });
          taken++;
        } catch { /* left as it is */ }
      } else {
        try {
          const noted = addNote({ board, rowId: id, text: note });
          board.setMeta(noted.root, { sheetNotes: [...(board.getMeta(noted.root).sheetNotes || []), receipt].slice(-50) });
          taken++;
        } catch { /* not a finished build: the note is left as it is */ }
      }
    }
  }
  state.sheetRows = extra;
  return taken;
}

/** Writes the board to the Sheet when something changed, and reads a person's edits back from it. */
async function syncBoardSheet({ call, boardId, board, state = {}, manifest = null, queue = null, addNote = null, now = Date.now, readBackMs = READ_BACK_MS }) {
  if (state.boardId !== boardId || !Number.isInteger(state.sheetId)) {
    const metadata = await call("get_spreadsheet_metadata", { spreadsheet_id: boardId });
    const titled = name => metadata?.sheets?.find(sheet => sheet.properties?.title === name)?.properties;
    const tab = titled(BOARD_TAB) || titled(OLDER_TAB);
    if (!Number.isInteger(tab?.sheetId)) throw Object.assign(new Error("The Tasks tab is missing from the Sheet."), { code: "SHEET_BOARD_TAB" });
    Object.assign(state, { boardId, sheetId: tab.sheetId, tabTitle: tab.title, rows: 0, last: null, written: null, sheetRows: 0, readAt: 0 });
  }
  let cameBack = 0;
  if (queue && addNote && now() - (state.readAt || 0) >= readBackMs) {
    state.readAt = now();
    cameBack = await readBackSheet({ call, boardId, board, state, manifest, queue, addNote });
  }
  const rows = boardValues(board);
  const fingerprint = JSON.stringify(rows);
  if (!cameBack && state.last === fingerprint) return { changed: false, rows: rows.length, cameBack };
  // Rows only ever grow, but blank out anything left over (and any line a person typed that
  // is now on the board under its own number) so the Sheet never shows a stale line.
  const leftover = Math.max(0, Math.max(state.rows || 0, state.sheetRows || 0) - rows.length);
  const values = [BOARD_HEADERS, ...rows, ...Array.from({ length: leftover }, () => BOARD_HEADERS.map(() => ""))];
  await call("batch_update_spreadsheet", { spreadsheet_id: boardId, requests: [{ updateCells: {
    start: { sheetId: state.sheetId, rowIndex: 0, columnIndex: 0 },
    rows: values.map(row => ({ values: row.map(cell) })),
    fields: "userEnteredValue",
  } }] });
  state.last = fingerprint;
  state.rows = rows.length;
  state.written = rows.map(row => row.map(cellText));
  state.sheetRows = rows.length;
  return { changed: true, rows: rows.length, cameBack };
}

/** Is this the Sheet the OS made and keeps current (as opposed to one the owner captures tasks into)? */
function mirrorTarget(manifest) {
  const sheets = manifest?.board?.sheets;
  return sheets?.provider === "codex" && sheets.mirror === true && typeof sheets.boardId === "string" && sheets.boardId
    ? sheets.boardId : null;
}

/** Keeps the Sheet current in the background. A Google outage never stops the work. */
function startSheetMirror({ board, manifest, call, intervalMs = SYNC_MS, onError = () => {}, readBackMs = READ_BACK_MS,
  queue = require("./request-flow.cjs").queueOrganizerRequest, addNote = require("./versions.cjs").addVersionNote }) {
  const state = {};
  let running = false;
  async function sync() {
    const boardId = mirrorTarget(manifest);
    if (!boardId || running) return { changed: false };
    running = true;
    try {
      return await syncBoardSheet({ call, boardId, board, state, manifest, queue, addNote, readBackMs });
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

module.exports = { BOARD_TAB, BOARD_HEADERS, READ_BACK_MS, createBoardSheet, syncBoardSheet, readBackSheet, startSheetMirror, mirrorTarget, boardValues, findSpreadsheetId, sheetUrl };
