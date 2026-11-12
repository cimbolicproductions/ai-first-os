"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { dispatchBoardTask, queueOrganizerRequest } = require("../lib/os-runtime.cjs");
const { classifyOrganizerRequest } = require("../lib/request-flow.cjs");
const { createBoardSheet, syncBoardSheet, startSheetMirror, mirrorTarget, findSpreadsheetId } = require("../lib/sheet-board.cjs");

/** A stand-in for Google that keeps real cells, so the test reads what a person would see. */
function fakeGoogle() {
  const files = new Map();
  const calls = [];
  async function call(tool, args) {
    calls.push(tool);
    if (tool === "create_file") {
      const id = "sheet_" + "x".repeat(24) + files.size;
      files.set(id, { tabs: [{ sheetId: 0, title: "Sheet1", cells: [] }] });
      return { file: { url: `https://docs.google.com/spreadsheets/d/${id}/edit` } };
    }
    const file = files.get(args.spreadsheet_id);
    if (!file) throw new Error("no such sheet");
    if (tool === "get_spreadsheet_metadata") {
      return { sheets: file.tabs.map(tab => ({ properties: { sheetId: tab.sheetId, title: tab.title } })) };
    }
    if (tool === "batch_update_spreadsheet") {
      for (const request of args.requests) {
        if (request.updateSheetProperties) {
          file.tabs.find(tab => tab.sheetId === request.updateSheetProperties.properties.sheetId).title = request.updateSheetProperties.properties.title;
        } else if (request.updateCells) {
          const tab = file.tabs.find(item => item.sheetId === request.updateCells.start.sheetId);
          request.updateCells.rows.forEach((row, offset) => {
            tab.cells[request.updateCells.start.rowIndex + offset] = row.values.map(value => value.userEnteredValue.stringValue);
          });
        }
      }
      return { ok: true };
    }
    throw new Error("unexpected tool " + tool);
  }
  return { call, calls, files, rows: id => files.get(id).tabs[0].cells.filter(row => row.some(Boolean)) };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-sheet-board-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const board = createLocalBoard({ boardDir: dir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = {
    board: { mode: "local", localDir: dir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "claude", researcher: "gemini", auditor: "codex" },
    settings: { autoAudit: false },
  };
  return { dir, board, manifest, notices: createNoticeBook({ dir }) };
}

test("asking in plain words makes the Sheet, and the board shows up in it with owners, statuses and notes", async t => {
  const { dir, board, manifest, notices } = setup(t);
  const google = fakeGoogle();
  let saved = 0;
  for (const words of ["Put my board in a Google Sheet", "can you create a Google Sheet for my tasks?", "Set up my spreadsheet."]) {
    assert.equal(classifyOrganizerRequest(words), "connect_sheet", words);
  }
  assert.notEqual(classifyOrganizerRequest("Create a spreadsheet parser in the repo"), "connect_sheet");

  const row = queueOrganizerRequest({ board, manifest, task: "Put my board in a Google Sheet" });
  const result = await dispatchBoardTask({
    workspaceRoot: dir, board, manifest, notices, taskId: row.ID,
    runner: async () => assert.fail("no agent is needed to make a Sheet"),
    saveManifest: () => { saved++; },
    createSheet: () => createBoardSheet({ call: google.call }),
  });
  assert.equal(result.status, "Done");
  assert.equal(saved, 1);
  const boardId = mirrorTarget(manifest);
  assert.ok(boardId, "the Sheet is remembered without anyone pasting an ID");
  assert.match(board.getMeta(row.ID).answer, /lives in a Google Sheet, and I keep it current\.\nhttps:\/\/docs\.google\.com\/spreadsheets\/d\//);
  assert.equal(google.files.get(boardId).tabs[0].title, "Board");

  board.addTask({ task: "Fix the login bug", to: "claude" });
  const state = {};
  assert.equal((await syncBoardSheet({ call: google.call, boardId, board, state })).changed, true);
  const [headers, first, second] = google.rows(boardId);
  assert.deepEqual(headers, ["ID", "Task", "Who has it", "Status", "Latest note", "Updated"]);
  assert.deepEqual(first.slice(0, 4), [row.ID, "Put my board in a Google Sheet", "Muse", "Done"]);
  assert.deepEqual(second.slice(0, 4), ["P2", "Fix the login bug", "Claude Code", "Queued"]);
  assert.doesNotMatch(first[4], /\[RUN /, "claim markers stay out of what a person reads");

  // Nothing changed, so Google is not called again. A change is written on the next pass.
  const before = google.calls.length;
  assert.equal((await syncBoardSheet({ call: google.call, boardId, board, state })).changed, false);
  assert.equal(google.calls.length, before);
  await dispatchBoardTask({ workspaceRoot: dir, board, manifest, notices, taskId: "P2", availability: { claude: true }, runner: async () => ({ status: "Done", note: "Fixed and tested." }) });
  await syncBoardSheet({ call: google.call, boardId, board, state });
  assert.deepEqual(google.rows(boardId)[2].slice(2, 5), ["Muse", "Done", "Fixed and tested."]);

  // Asking twice does not make a second Sheet.
  const again = queueOrganizerRequest({ board, manifest, task: "Put my board in a Google Sheet" });
  await dispatchBoardTask({ workspaceRoot: dir, board, manifest, notices, taskId: again.ID, createSheet: () => assert.fail("already connected") });
  assert.match(board.getMeta(again.ID).answer, /already in a Google Sheet/);

  // With the board in the Sheet, "add tasks" goes on the board itself.
  const add = queueOrganizerRequest({ board, manifest, task: "Add tasks:\nCall the plumber\nOrder filters" });
  await dispatchBoardTask({ workspaceRoot: dir, board, manifest, notices, taskId: add.ID });
  assert.deepEqual(board.listTasks().slice(-2).map(item => item.Task), ["Call the plumber", "Order filters"]);
});

test("when Google is not connected it says how to connect, and a Google outage never stops the work", async t => {
  const { dir, board, manifest, notices } = setup(t);
  const row = queueOrganizerRequest({ board, manifest, task: "Put my board in a Google Sheet" });
  await dispatchBoardTask({
    workspaceRoot: dir, board, manifest, notices, taskId: row.ID,
    createSheet: async () => { throw new Error("connector missing"); },
  });
  const ask = notices.listOpen().find(n => n.row === row.ID);
  assert.match(ask.text, /open Codex, sign in, and connect Google Drive\. Then tap Try again\./);
  assert.equal(mirrorTarget(manifest), null);

  manifest.board.sheets = { provider: "codex", boardId: "b".repeat(30), mirror: true };
  const errors = [];
  const mirror = startSheetMirror({ board, manifest, call: async () => { throw new Error("offline"); }, intervalMs: 60000, onError: error => errors.push(error.message) });
  t.after(() => mirror.stop());
  board.addTask({ task: "Still gets queued", to: "claude" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await mirror.sync()).changed, false);
  assert.ok(errors.includes("offline"));
  assert.equal(board.listTasks().at(-1).Status, "Open");

  assert.equal(findSpreadsheetId({ result: { id: "1AbC_dEf-GhIjKlMnOpQrStUvWx" } }), "1AbC_dEf-GhIjKlMnOpQrStUvWx");
  assert.equal(findSpreadsheetId({ nothing: "here" }), null);
});
