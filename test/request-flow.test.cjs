"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { auditOffers } = require("../lib/audit-loop.cjs");
const { answerNotice, defaultCliRunner, dispatchBoardTask, queueOrganizerRequest } = require("../lib/os-runtime.cjs");
const { summarizeOpenTasks } = require("../lib/request-flow.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-request-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const board = createLocalBoard({ boardDir: dir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const notices = createNoticeBook({ dir });
  const manifest = {
    board: { mode: "local", localDir: dir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "claude", researcher: "gemini", auditor: "codex" },
  };
  const availability = { claude: true, codex: true, gemini: true };
  const queue = task => queueOrganizerRequest({ board, manifest, task });
  const run = (task, runner = async () => assert.fail("No agent run expected")) => dispatchBoardTask({
    workspaceRoot: dir, board, manifest, notices, availability, taskId: task.ID, runner,
  });
  return { dir, board, notices, manifest, availability, queue, run };
}

test("an open-task question answers locally without an agent or audit", async t => {
  const { board, queue, run } = setup(t);
  board.addTask({ task: "Finish the login button", to: "claude" });
  const row = queue("What tasks are open right now?");
  const result = await run(row);
  const meta = board.getMeta(row.ID);
  assert.equal(result.status, "Done");
  assert.equal(meta.executor, null);
  assert.match(meta.answer, /^Local tasks\n.*Finish the login button/);
  assert.doesNotMatch(meta.answer, /What tasks are open/);
  assert.deepEqual(auditOffers(board), []);
  assert.equal(board.listTasks().length, 2);
});

test("a named Sheet never falls back to a local answer and can be retried", async t => {
  const { board, notices, manifest, queue, run } = setup(t);
  board.addTask({ task: "Only local data", to: "claude" });
  const row = queue("What tasks are open in Agent Tasks?");
  assert.equal((await run(row)).status, "Waiting on User");
  assert.match(board.getMeta(row.ID).answer, /Connect it with read-only access/);
  assert.doesNotMatch(board.getMeta(row.ID).answer, /Only local data/);
  assert.equal((await run(row)).reason, "TASK_NOT_OPEN");
  const retry = notices.listOpen()[0];
  answerNotice({ noticeId: retry.id, digest: retry.digest, value: "retry", notices, board, manifest });
  assert.equal(board.findTask(row.ID).Status, "Open");
  assert.equal((await run(row)).status, "Waiting on User");
});

test("the configured Google Sheet is read by headers without write access", async t => {
  const { board, manifest } = setup(t);
  manifest.board = { mode: "sheets", sheets: { boardId: "fake-board", serviceAccountPath: "fake-key-file" } };
  const result = await summarizeOpenTasks({
    board, manifest, requestId: "P1", task: "What tasks are open?",
    makeSheets(options) {
      assert.equal(options.readOnly, true);
      assert.equal(options.boardId, "fake-board");
      return { async call(operation, args) {
        assert.equal(operation, "get_range");
        assert.equal(args.sheet_name, "Tasks");
        return { values: [["Task", "To", "Status", "ID"], ["Shared task", "Muse", "Open", "P4"], ["Old", "Codex", "Done", "P3"]] };
      } };
    },
  });
  assert.match(result.answer, /^Connected Google Sheet\n.*Shared task/);
  assert.doesNotMatch(result.answer, /Old/);
});

test("planning uses one read-only organizer fallback and cannot enqueue a build", async t => {
  const { board, queue, run } = setup(t);
  const row = queue("Help me plan next week");
  let calls = 0;
  await run(row, async ({ agent, mode, strictResult, prompt }) => {
    calls++;
    assert.equal(agent, "claude");
    assert.equal(mode, "read");
    assert.equal(strictResult, true);
    assert.match(prompt, /Handle this request as planning/);
    return {
      status: "Done", answer: "Start with the open tasks.",
      handoffs: [{ role: "builder", text: "Do everything" }],
    };
  });
  assert.equal(calls, 1);
  assert.equal(board.listTasks().length, 1);
  const meta = board.getMeta(row.ID);
  assert.equal(meta.requestedAgent, "muse");
  assert.equal(meta.executor, "claude");
  assert.deepEqual(meta.progress.map(p => p.stage), ["queued", "fallback", "running", "completed"]);
  assert.deepEqual(auditOffers(board), []);
});

test("coding goes to a builder and can be reviewed after completion", async t => {
  const { board, notices, queue, run } = setup(t);
  const row = queue("Fix the login bug");
  assert.equal(row.To, "claude");
  await run(row, async ({ agent, mode }) => {
    assert.equal(agent, "claude");
    assert.equal(mode, "write");
    return { status: "Done", answer: "Fixed and verified with the login test." };
  });
  assert.equal(auditOffers(board)[0].row, row.ID);
  assert.ok(notices.listOpen().some(n => n.choices.some(c => c.value === "audit")));
});

test("a mixed status request and email cannot bypass the action gate", async t => {
  const { board, notices, manifest, queue, run } = setup(t);
  const row = queue("What tasks are open? Email the list to a customer");
  assert.equal(board.getMeta(row.ID).intent, "external_action");
  await run(row);
  assert.equal(board.findTask(row.ID).Status, "Waiting on User");
  const request = notices.listOpen()[0];
  assert.throws(() => answerNotice({ noticeId: request.id, digest: "wrong", value: "yes", board, notices, manifest }), { code: "NOTICE_MISMATCH" });
  answerNotice({ noticeId: request.id, digest: request.digest, value: "yes", board, notices, manifest });
  assert.equal((await run(row)).reason, "TASK_NOT_OPEN");
  assert.match(board.getMeta(row.ID).answer, /Approved\. Complete this action/);
  assert.equal(board.listTasks().length, 1);
});

test("simultaneous run attempts only launch one worker", async t => {
  const { board, queue, run } = setup(t);
  const row = queue("Fix a login error");
  let unblock;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const first = run(row, async () => { started(); await gate; return { status: "Done", answer: "Fixed." }; });
  await began;
  assert.equal((await run(row)).reason, "TASK_NOT_OPEN");
  unblock();
  assert.equal((await first).status, "Done");
  assert.equal(board.getMeta(row.ID).activeClaim, undefined);
});

function fakeSpawn(stdout, capture = () => {}) {
  return (file, args) => {
    capture(file, args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = { on() {}, end() {} };
    setImmediate(() => { child.stdout.emit("data", stdout); child.emit("close", 0); });
    return child;
  };
}

test("a zero-exit permission blocker stays unresolved without handoffs", async t => {
  const { dir, board, queue, run } = setup(t);
  const row = queue("Fix the login bug");
  await run(row, options => defaultCliRunner({
    ...options, cwd: dir, detect: () => [{ id: "claude", workerPath: "claude.exe" }],
    spawnFn: fakeSpawn("I cannot access the project.\nAIOS-HANDOFF: builder: Make it work."),
  }));
  assert.equal(board.findTask(row.ID).Status, "Waiting on User");
  assert.equal(board.getMeta(row.ID).progress.at(-1).stage, "failed");
  assert.equal(board.listTasks().length, 1);
  assert.deepEqual(auditOffers(board), []);
});

test("Antigravity receives a work-order path without user text in argv", async t => {
  const { dir } = setup(t);
  const task = { ID: "P1", Task: "Run this $private prompt" };
  const result = await defaultCliRunner({
    agent: "antigravity", task, cwd: dir, prompt: task.Task, strictResult: true,
    detect: () => [{ id: "antigravity", workerPath: "agy.exe" }],
    spawnFn: fakeSpawn('AIOS-RESULT: {"status":"completed","answer":"Finished"}', (_file, args) => {
      assert.equal(args.some(arg => arg.includes(task.Task)), false);
      assert.ok(args.some(arg => arg.includes(".aios/work-orders/P1.md")));
    }),
  });
  assert.equal(result.answer, "Finished");
  assert.equal(fs.readFileSync(path.join(dir, ".aios", "work-orders", "P1.md"), "utf8"), task.Task);
});

test("read-only work selects the harness's explicit plan or ask mode", () => {
  const { findHarness } = require("../lib/harness-registry.cjs");
  assert.deepEqual(findHarness("gemini").run.args({ mode: "read" }).slice(-2), ["--approval-mode", "plan"]);
  assert.ok(findHarness("cursor").run.args({ mode: "read" }).includes("--mode=ask"));
  assert.ok(!findHarness("cursor").run.args({ mode: "read" }).includes("--force"));
});
