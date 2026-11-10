"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSheetTasks } = require("../lib/sheet-tasks.cjs");
const { createOwnerSheetTransport, prepareRequest } = require("../adapters/sheets-board.cjs");

const headers = ["ID", "Task", "To", "Status", "Latest note", "Order", "From", "Updated", "Created", "Spec file"];
const meta = {
  properties: { timeZone: "America/Chicago" },
  sheets: ["Tasks", "Done"].map((title, index) => ({ properties: {
    title, sheetId: 70 + index, gridProperties: { rowCount: 5, columnCount: 12 },
  } })),
};

let fixtureNumber = 0;
function fixture({ reorder = false } = {}) {
  const header = [...headers];
  if (reorder) [header[0], header[1]] = [header[1], header[0]];
  function row(id, task, status) {
    const values = [id, task, "Dom", status, "Previous note", "7", "Dom", "2026-11-01", "2026-10-28", "none"];
    return header.map(name => values[headers.indexOf(name)]);
  }
  const tabs = {
    Tasks: [header, row("P4", "Check the dryer", "Open"), row("P6", "Done already", "Done")],
    Done: [header, row("P12", "Archived", "Done")],
  };
  const writes = [];
  let beforeCellRead;
  const transport = {
    getMetadata: async () => structuredClone(meta),
    async readRange(tab, range) {
      const [, first, last] = /^A(\d+):[A-Z]+(\d+)$/.exec(range);
      if (tab === "Tasks" && first === last && first !== "1") beforeCellRead?.();
      return structuredClone(tabs[tab].slice(Number(first) - 1, Number(last)));
    },
    async appendRows(sheetId, rows) {
      assert.equal(sheetId, 70);
      writes.push(["append", rows]);
      tabs.Tasks.push(...structuredClone(rows));
    },
    async updateCells(sheetId, rowIndex, cells) {
      assert.equal(sheetId, 70);
      writes.push(["update", rowIndex, cells]);
      for (const { column, value } of cells) tabs.Tasks[rowIndex][column] = value;
    },
  };
  const manifest = { board: { sheets: {
    provider: "codex", boardId: "fake-sheet-" + ++fixtureNumber, ownerName: "Dom",
  } } };
  const service = createSheetTasks({ manifest, makeTransport: () => transport, now: () => new Date("2026-11-10T03:30:00Z") });
  return { service, tabs, transport, writes, row, moveBeforeWrite: fn => { beforeCellRead = fn; } };
}

test("lists live task rows by header, then captures literal tasks after IDs in both tabs", async () => {
  const { service, tabs, writes } = fixture({ reorder: true });
  assert.equal(service.configured, true);
  assert.deepEqual((await service.listOpen()).map(row => row.id), ["P4"]);
  const capture = { tasks: ["=not a formula", "Pick up mail"], requestId: "capture-1234", source: "phone" };
  const tasks = await service.add(capture);
  assert.deepEqual(tasks.map(row => [row.id, row.task, row.to, row.status, row.order]), [
    ["P13", "=not a formula", "Dom", "Open", "8"], ["P14", "Pick up mail", "Dom", "Open", "9"],
  ]);
  assert.equal(tabs.Tasks[3][0], "=not a formula", "task column was swapped with ID in the header");
  assert.match(tasks[0].note, /^Dom 2026-11-09: Captured on the phone\./);
  assert.equal(tasks[0].specFile, "none");
  assert.equal((await service.add(capture))[0].id, "P13");
  assert.equal(writes.length, 1);
  await assert.rejects(service.add({ ...capture, tasks: ["Different"] }), { code: "SHEET_CONFLICT" });
});

test("serializes concurrent captures and retains previous notes while updating the chosen task", async () => {
  const { service, tabs, writes } = fixture();
  const captures = await Promise.all([
    service.add({ tasks: ["One"], requestId: "parallel-100" }),
    service.add({ tasks: ["Two"], requestId: "parallel-200" }),
  ]);
  assert.deepEqual(captures.flat().map(row => row.id), ["P13", "P14"]);
  const [task] = await service.listOpen();
  const update = { id: task.id, task: "Check the dryer today", status: "Done", revision: task.revision, requestId: "update-1234" };
  const result = await service.update(update);
  assert.equal(result.task, update.task);
  assert.equal(result.status, "Done");
  assert.match(result.note, /^Previous note\nDom 2026-11-09: Updated on the computer\./);
  assert.deepEqual((await service.listOpen()).map(row => row.id), ["P13", "P14"]);
  assert.equal((await service.update(update)).revision, result.revision);
  assert.equal(writes.filter(write => write[0] === "update").length, 1);
  assert.equal(tabs.Tasks[1][2], "Dom", "assignee is untouched");
  await assert.rejects(service.update({ ...update, requestId: "update-stale" }), { code: "SHEET_CONFLICT" });
});

test("refuses stale and duplicate rows before writing", async () => {
  const moved = fixture();
  const [task] = await moved.service.listOpen();
  moved.moveBeforeWrite(() => { [moved.tabs.Tasks[1], moved.tabs.Tasks[2]] = [moved.tabs.Tasks[2], moved.tabs.Tasks[1]]; });
  const update = { id: task.id, revision: task.revision, status: "Done", requestId: "update-moved" };
  await assert.rejects(moved.service.update(update), { code: "SHEET_CONFLICT" });
  assert.equal(moved.writes.length, 0);

  const duplicate = fixture();
  duplicate.tabs.Done.push(duplicate.row("P4", "Different task", "Done"));
  await assert.rejects(duplicate.service.update(update), { code: "SHEET_ID_COLLISION" });
  assert.equal(duplicate.writes.length, 0);
});

test("ambiguous save checks for the receipt without resubmitting", async () => {
  const { service, tabs, transport, writes } = fixture();
  let delayedRows;
  transport.appendRows = async (_, rows) => {
    writes.push(rows);
    delayedRows = rows;
    throw Object.assign(new Error("Socket lost"), { code: "HTTP_ERROR" });
  };
  const capture = { tasks: ["Wait for receipt"], requestId: "capture-delay" };
  await assert.rejects(service.add(capture), { code: "SHEET_UNCONFIRMED" });
  await assert.rejects(service.add(capture), { code: "SHEET_UNCONFIRMED" });
  assert.equal(writes.length, 1);
  tabs.Tasks.push(...delayedRows);
  assert.equal((await service.add(capture))[0].id, "P13");
  assert.equal(writes.length, 1);
});

test("owner transport writes literal cells and leaves agent write validation intact", async () => {
  const boardId = "fake-spreadsheet";
  const sent = [];
  const transport = createOwnerSheetTransport({
    boardId,
    tokenProvider: async () => "fixture-token",
    async fetchImpl(url, init) {
      sent.push({ url, body: JSON.parse(init.body) });
      return Response.json({ replies: [{}] });
    },
  });
  await transport.appendRows(70, [["P4", "=SUM(A1:A9)"]]);
  assert.match(sent[0].url, /fake-spreadsheet:batchUpdate$/);
  assert.deepEqual(sent[0].body.requests[0].appendCells.rows[0].values[1],
    { userEnteredValue: { stringValue: "=SUM(A1:A9)" } });
  await transport.updateCells(70, 5, [{ column: 3, value: "Done" }]);
  assert.deepEqual(sent[1].body.requests[0].updateCells.range,
    { sheetId: 70, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 3, endColumnIndex: 4 });
  const agentRequest = { operation: "batch_update", arguments: { requests: [{ appendCells: {
    sheetId: 0, rows: [{ values: [] }], fields: "userEnteredValue",
  } }] } };
  assert.throws(() => prepareRequest(agentRequest, { boardId, readOnly: false, allowWrites: true }), { code: "INVALID_REQUEST" });
});

test("malformed Google reads never look like empty tasks", async () => {
  let data = { bogus: true };
  const transport = createOwnerSheetTransport({
    boardId: "fake-spreadsheet", tokenProvider: async () => "fixture-token",
    fetchImpl: async () => Response.json(data),
  });
  await assert.rejects(transport.readRange("Tasks", "A2:J5"), { code: "SHEETS_INVALID_RESPONSE" });
  data = { range: "Tasks!A2:J5", majorDimension: "ROWS" };
  assert.deepEqual(await transport.readRange("Tasks", "A2:J5"), []);
});
