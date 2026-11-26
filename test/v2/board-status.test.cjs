"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { boardQuestionIntent, boardTaskLookupId, readBoardStatus, readBoardTask } = require("../../lib/v2/board-status.cjs");
const { createStore } = require("../../lib/v2/store.cjs");
const { createPipeline } = require("../../lib/v2/pipeline.cjs");

const owner = content => ({ role: "owner", content });

test("recognizes board status and the owner's Agent Tasks clarification without intercepting writes", () => {
  assert.equal(boardQuestionIntent([owner("What’s next on the board?")]), "overview");
  assert.equal(boardQuestionIntent([owner("What's on my board?")]), "overview");
  assert.equal(boardQuestionIntent([owner("What tasks are at hand?")]), "overview");
  assert.equal(boardQuestionIntent([
    owner("What's next?"),
    { role: "intake", content: "Which board are you asking about?" },
    owner("i agent tasks is what i was asking about"),
  ]), "overview");
  assert.equal(boardQuestionIntent([owner("What tasks are waiting on me in Agent Tasks?")]), "waiting_on_owner");
  assert.equal(boardQuestionIntent([owner("Which are waiting on me?")]), null);
  assert.equal(boardQuestionIntent([owner("Add a task to Agent Tasks.")]), null);
  assert.equal(boardQuestionIntent([owner("Check Agent Tasks and build the top item.")]), null);
  assert.equal(boardQuestionIntent([owner("What's next on the board?"), owner("Mark P21 done.")]), null);
  assert.equal(boardQuestionIntent([owner("What's next on the board?"), owner("Mark P21 done."), owner("Which are waiting on me?")]), null);
  assert.equal(boardQuestionIntent([{ role: "intake", content: "What's next on the board?" }]), null);
});

test("identifies a single task question without treating action requests as lookups", () => {
  for (const text of ["What is P188?", "And p188?", "What’s the status of P188?", "Could you look up P188?"]) {
    assert.equal(boardTaskLookupId(text), "P188");
  }
  for (const text of ["Continue P188", "Mark P188 done", "What is P188 and can you close it?", "What are P188 and P189?"]) {
    assert.equal(boardTaskLookupId(text), null);
  }
});

function boardFixture({ archived = false } = {}) {
  const calls = [];
  const values = {
    "A1:G1": [["ID", "To", "Task", "Status", "Latest note", "Order", "From"]],
    "A2:A7": [["P10"], [], ["P11"], ["P12"], ["P13"], ["P14"]],
    "A7:D7": [["P14", "Juno", "Needs approval", "Waiting on Dom"]],
    "B2:B7": [["Codex"], [], ["Codex"], ["Claude"], ["Codex"], ["Juno"]],
    "C2:C7": [["Lower priority"], [], ["Next Codex task"], ["Claude is underway"], ["Finished task"], ["Needs approval"]],
    "D2:D7": [["Open"], [], ["Open"], ["In progress"], ["Done"], ["Waiting on Dom"]],
    "F2:F7": [["7"], [], ["2"], ["4"], ["1"], ["1"]],
  };
  return {
    calls,
    async callGoogleDrive(tool, args) {
      calls.push([tool, args]);
      if (tool === "get_spreadsheet_metadata") {
        const tabs = [{ title: "Tasks", gridProperties: { rowCount: 7, columnCount: 7 } }];
        if (archived) tabs.push({ title: "Done", gridProperties: { rowCount: 6, columnCount: 4 } });
        return { sheets: tabs.map(properties => ({ properties })) };
      }
      assert.equal(tool, "get_spreadsheet_range");
      if (args.sheet_name === "Done") {
        const done = {
          "A1:D1": [["Status", "Task", "ID", "To"]],
          "C2:C6": [["P1880"], [], ["p188"], ["P14"], []],
          "A4:D4": [["Done", "Archived connector task", "p188", "Claude"]],
          "A5:D5": [["Done", "Different archived item", "P14", "Claude"]],
        };
        assert.ok(archived && Object.hasOwn(done, args.range));
        return { majorDimension: "ROWS", range: args.range, values: done[args.range] };
      }
      assert.equal(args.sheet_name, "Tasks");
      assert.ok(Object.hasOwn(values, args.range));
      return { majorDimension: "ROWS", range: args.range, values: values[args.range] };
    },
  };
}

test("reads bounded Agent Tasks columns by header and reports the lowest order for each assignee", async () => {
  const { calls, callGoogleDrive } = boardFixture();
  const answer = await readBoardStatus({ boardId: "board-fixture", callGoogleDrive });
  assert.ok(calls.every(([, args]) => args.spreadsheet_id === "board-fixture"));
  assert.equal(calls.length, 7);
  assert.match(answer, /3 open or in progress and 1 waiting on Dom/);
  assert.match(answer, /P11 · Codex · Next Codex task \(Open, order 2\)/);
  assert.match(answer, /P12 · Claude · Claude is underway \(In progress, order 4\)/);
  assert.doesNotMatch(answer, /Lower priority|Finished task|Needs approval/);
});

test("checks active and archived IDs exactly and reports missing or duplicate IDs", async () => {
  const { callGoogleDrive, calls } = boardFixture({ archived: true });
  const lookup = taskId => readBoardTask({ boardId: "board-fixture", callGoogleDrive, taskId });
  const answer = await lookup("P188");
  assert.match(answer, /^P188 is assigned to Claude.*Done.*\nArchived connector task/);
  assert.ok(calls.some(([, args]) => args.sheet_name === "Done" && args.range === "A4:D4"));
  assert.match(await lookup("P19"), /couldn’t find P19.*Tasks and Done/);
  assert.match(await lookup("P14"), /2 entries for P14[\s\S]*Needs approval[\s\S]*Different archived item/);
});

test("answers a waiting-on-me follow-up in a completed board thread, without launching an agent", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aios-board-followup-"));
  const store = createStore({ dbPath: ":memory:" });
  try {
    const { calls, callGoogleDrive } = boardFixture();
    const pipeline = createPipeline({
      store, profileDir: tmp, runsDir: path.join(tmp, "runs"), worktreesDir: path.join(tmp, "worktrees"),
      getProfile: () => ({ connectors: { sheetsSync: { boardId: "board-fixture", enabled: false } } }),
      detect: () => [],
      runner: () => assert.fail("Board follow-up shouldn't launch a worker"),
      callGoogleDrive,
    });
    const task = store.createTask({ text: "What's next on the board?" });
    store.addThreadMessage({ taskId: task.id, role: "owner", content: "i agent tasks is what i was asking about" });
    assert.equal((await pipeline.processTask(task.id)).status, "done");

    const reopened = pipeline.replyToTask(task.id, { reply: "which are waiting on me?", source: "phone" });
    assert.equal(reopened.stage, "intake");
    const result = await pipeline.processTask(task.id);
    assert.equal(result.status, "done");
    assert.match(result.answer, /1 task waiting on you/);
    assert.match(result.answer, /P14 · Juno · Needs approval/);
    assert.doesNotMatch(result.answer, /P11|P12|P13/);
    assert.equal(store.getTask(task.id).projectPath, null);
    assert.equal(fs.existsSync(path.join(tmp, "worktrees")), false);
    assert.equal(calls.length, 14);
    assert.equal(store.getThread(task.id).at(-1).content, result.answer);

    assert.equal(pipeline.replyToTask(task.id, { reply: "What is P14?", source: "phone" }).id, task.id);
    const lookup = await pipeline.processTask(task.id);
    assert.equal(lookup.status, "done");
    assert.match(lookup.answer, /^P14 is assigned to Juno.*Waiting on Dom.*\nNeeds approval/);
    assert.doesNotMatch(lookup.answer, /1 task waiting on you|P11|P12|P13/);
    const message = store.getThread(task.id).at(-1);
    assert.equal(message.role, "assistant");
    assert.equal(message.kind, "message");
    assert.equal(message.meta.boardIntent, "task_lookup");
    assert.equal(message.content, lookup.answer);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("intake understands a board question before the backend reads it and keeps board data out of later prompts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aios-board-intent-"));
  const store = createStore({ dbPath: ":memory:" });
  try {
    const { calls, callGoogleDrive } = boardFixture();
    const prompts = [];
    const pipeline = createPipeline({
      store, profileDir: tmp, runsDir: path.join(tmp, "runs"), worktreesDir: path.join(tmp, "worktrees"),
      getProfile: () => ({ connectors: { sheetsSync: { boardId: "board-fixture", enabled: false } } }),
      detect: () => [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, headless: true }],
      runner: async ({ prompt, mode }) => {
        assert.equal(mode, "read");
        prompts.push(prompt);
        if (prompts.length === 1) {
          assert.equal(calls.length, 0, "intake should understand the request before the board is read");
          return { ok: true, structured: { status: "board_read", intent: "overview" } };
        }
        if (prompts.length === 3) {
          assert.match(prompt, /refresh my memory about the work in P14/i);
          return { ok: true, structured: { status: "board_read", intent: "task_lookup", taskId: "P14" } };
        }
        if (prompts.length === 4) {
          assert.doesNotMatch(prompt, /Needs approval/);
          return { ok: true, structured: { status: "board_read", intent: "task_lookup", taskId: "P14" } };
        }
        assert.match(prompt, /which ones need a decision from me\?/i);
        assert.match(prompt, /Agent Tasks/);
        assert.doesNotMatch(prompt, /Next Codex task|Claude is underway/);
        assert.equal(calls.length, 7);
        return { ok: true, structured: { status: "board_read", intent: "waiting_on_owner" } };
      },
      callGoogleDrive,
    });
    const task = store.createTask({ text: "What's next on the board?" });
    assert.equal((await pipeline.processTask(task.id)).status, "done");
    const overview = store.getThread(task.id).at(-1);
    assert.equal(overview.role, "assistant");
    assert.equal(overview.kind, "message");
    assert.equal(overview.meta.boardIntent, "overview");
    assert.match(overview.content, /P11 · Codex · Next Codex task/);

    const reopened = pipeline.replyToTask(task.id, { reply: "Which ones need a decision from me?", source: "phone" });
    assert.equal(reopened.id, task.id);
    assert.equal((await pipeline.processTask(task.id)).status, "done");
    const waiting = store.getThread(task.id).at(-1);
    assert.equal(waiting.meta.boardIntent, "waiting_on_owner");
    assert.match(waiting.content, /P14 · Juno · Needs approval/);
    assert.equal(prompts.length, 2);
    assert.equal(calls.length, 14);
    assert.equal(fs.existsSync(path.join(tmp, "worktrees")), false);

    pipeline.replyToTask(task.id, { reply: "Could you refresh my memory about the work in P14?" });
    assert.match((await pipeline.processTask(task.id)).answer, /^P14 is assigned to Juno.*\nNeeds approval/);
    assert.equal(calls.length, 18);

    pipeline.replyToTask(task.id, { reply: "Could you refresh my memory about the work in P15?" });
    assert.match((await pipeline.processTask(task.id)).answer, /Which Agent Tasks number/);
    assert.equal(calls.length, 18);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
