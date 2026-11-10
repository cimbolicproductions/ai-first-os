"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCodexSheetTransport } = require("../lib/codex-sheet-transport.cjs");

test("the connected Sheets transport keeps writes literal and scoped to the requested cells", async () => {
  const calls = [];
  const transport = createCodexSheetTransport({ boardId: "board-fixture" }, async (tool, args) => {
    calls.push([tool, args]);
    if (tool === "get_spreadsheet_range") return { range: "Tasks!A1:A1", majorDimension: "ROWS", values: [["ID"]] };
    return { replies: [{}] };
  });
  assert.deepEqual(await transport.readRange("Tasks", "A1:A1"), [["ID"]]);
  await transport.appendRows(4, [["P1", "=1+1"]]);
  await transport.updateCells(4, 3, [{ column: 1, value: "=2+2" }]);
  assert.ok(calls.every(([, args]) => args.spreadsheet_id === "board-fixture"));
  assert.equal(calls[1][1].requests[0].appendCells.rows[0].values[1].userEnteredValue.stringValue, "=1+1");
  const update = calls[2][1].requests[0].updateCells;
  assert.deepEqual(update.range, { sheetId: 4, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 2 });
  assert.equal(update.rows[0].values[0].userEnteredValue.stringValue, "=2+2");
});


test("the connector's empty range is valid only with a range envelope", async () => {
  const empty = createCodexSheetTransport({ boardId: "fixture" }, async () => ({ range: "Tasks!A2:J3", majorDimension: "ROWS", values: null }));
  assert.deepEqual(await empty.readRange("Tasks", "A2:J3"), []);
  const malformed = createCodexSheetTransport({ boardId: "fixture" }, async () => ({ values: null }));
  await assert.rejects(malformed.readRange("Tasks", "A2:J3"), { code: "SHEET_RESPONSE" });
});
