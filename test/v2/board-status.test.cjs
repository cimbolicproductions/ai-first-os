"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { matchBoardQuestion, readBoardStatus } = require("../../lib/v2/board-status.cjs");

const owner = content => ({ role: "owner", content });

test("recognizes board status and the owner's Agent Tasks clarification without intercepting writes", () => {
  assert.equal(matchBoardQuestion([owner("What’s next on the board?")]), true);
  assert.equal(matchBoardQuestion([owner("What's on my board?")]), true);
  assert.equal(matchBoardQuestion([owner("What tasks are at hand?")]), true);
  assert.equal(matchBoardQuestion([
    owner("What's next?"),
    { role: "intake", content: "Which board are you asking about?" },
    owner("i agent tasks is what i was asking about"),
  ]), true);
  assert.equal(matchBoardQuestion([owner("Add a task to Agent Tasks.")]), false);
  assert.equal(matchBoardQuestion([owner("Check Agent Tasks and build the top item.")]), false);
  assert.equal(matchBoardQuestion([owner("What's next on the board?"), owner("Mark P21 done.")]), false);
  assert.equal(matchBoardQuestion([{ role: "intake", content: "What's next on the board?" }]), false);
});

test("reads bounded Agent Tasks columns by header and reports the lowest order for each assignee", async () => {
  const calls = [];
  const values = {
    "A1:G1": [["ID", "To", "Task", "Status", "Latest note", "Order", "From"]],
    "A2:A7": [["P10"], [], ["P11"], ["P12"], ["P13"], ["P14"]],
    "B2:B7": [["Codex"], [], ["Codex"], ["Claude"], ["Codex"], ["Juno"]],
    "C2:C7": [["Lower priority"], [], ["Next Codex task"], ["Claude is underway"], ["Finished task"], ["Needs approval"]],
    "D2:D7": [["Open"], [], ["Open"], ["In progress"], ["Done"], ["Waiting on Dom"]],
    "F2:F7": [["7"], [], ["2"], ["4"], ["1"], ["1"]],
  };
  const answer = await readBoardStatus({
    boardId: "board-fixture",
    async callGoogleDrive(tool, args) {
      calls.push([tool, args]);
      if (tool === "get_spreadsheet_metadata") {
        return { sheets: [{ properties: { title: "Tasks", gridProperties: { rowCount: 7, columnCount: 7 } } }] };
      }
      assert.equal(tool, "get_spreadsheet_range");
      assert.equal(args.sheet_name, "Tasks");
      assert.ok(Object.hasOwn(values, args.range));
      return { majorDimension: "ROWS", range: args.range, values: values[args.range] };
    },
  });
  assert.ok(calls.every(([, args]) => args.spreadsheet_id === "board-fixture"));
  assert.equal(calls.length, 7);
  assert.match(answer, /3 open or in progress and 1 waiting on Dom/);
  assert.match(answer, /P11 · Codex · Next Codex task \(Open, order 2\)/);
  assert.match(answer, /P12 · Claude · Claude is underway \(In progress, order 4\)/);
  assert.doesNotMatch(answer, /Lower priority|Finished task|Needs approval/);
});
