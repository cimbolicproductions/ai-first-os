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
const { answerNotice, defaultCliRunner, dispatchBoardTask, queueOrganizerRequest, replyToOrganizer } = require("../lib/os-runtime.cjs");
const { summarizeOpenTasks, parseRequestResult } = require("../lib/request-flow.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-request-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const board = createLocalBoard({ boardDir: dir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const notices = createNoticeBook({ dir });
  const manifest = {
    board: { mode: "local", localDir: dir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "claude", researcher: "antigravity", auditor: "codex" },
  };
  const availability = { claude: true, codex: true, antigravity: true };
  const queue = task => queueOrganizerRequest({ board, manifest, task });
  const run = (task, runner = async () => assert.fail("No agent run expected")) => dispatchBoardTask({
    workspaceRoot: dir, board, manifest, notices, availability, taskId: task.ID, runner,
  });
  return { dir, board, notices, manifest, availability, queue, run };
}

test("a voice dump becomes separate board tasks, one owner each, and gated work still asks", async t => {
  const { board, notices, queue, run } = setup(t);
  const row = queue("ok so fix the login bug on the site\nnext task look up what competitors charge\nalso email the landlord about the lease");
  assert.equal(row.To, "muse");
  await run(row, async ({ mode, prompt }) => {
    assert.equal(mode, "read");
    assert.match(prompt, /"status":"tasks"/);
    return { status: "Waiting on User", result: "tasks", answer: "Three things, on the board now.", split: [
      { role: "builder", work: "Fix the login bug on the site" },
      { role: "researcher", work: "Look up what competitors charge" },
      { role: "builder", work: "Email the landlord about the lease" },
    ] };
  });
  assert.equal(board.findTask(row.ID).Status, "Done");
  const [fix, research, send] = board.listTasks().slice(1);
  assert.deepEqual([fix.To, fix.Status, board.getMeta(fix.ID).kind], ["claude", "Open", "build"]);
  assert.deepEqual([research.To, board.getMeta(research.ID).kind], ["antigravity", "research"]);
  assert.equal(board.getMeta(fix.ID).splitFrom, row.ID);
  // Sending to another person is never handed straight to a worker.
  assert.deepEqual([send.To, board.getMeta(send.ID).intent], ["muse", "external_action"]);
  await run(send);
  const approval = notices.listOpen().find(n => n.row === send.ID);
  assert.equal(approval.kind, "approval");
  assert.match(board.getMeta(row.ID).answer, /P2 Fix the login bug on the site · Claude Code/);
  assert.match(board.getMeta(row.ID).answer, /needs your yes/);
  assert.equal(notices.listOpen().some(n => /Muse put 3 things on the board/.test(n.text)), true);

  // A question never turns into building nobody asked for.
  const idle = queue("What do you think about the weather today?");
  await run(idle, async () => ({ status: "Waiting on User", result: "tasks", answer: "Sure.", split: [{ role: "builder", work: "Rewrite the whole site" }] }));
  const invented = board.listTasks().at(-1);
  assert.deepEqual([invented.To, board.getMeta(invented.ID).musePhase], ["muse", "organize"]);

  const line = text => parseRequestResult("thinking\nAIOS-RESULT: " + JSON.stringify(text));
  assert.equal(line({ status: "tasks", answer: "Two.", tasks: [{ role: "builder", work: " A " }, { role: "researcher", work: "B" }] }).split[0].work, "A");
  assert.equal(line({ status: "tasks", answer: "None.", tasks: [] }), null);
  assert.equal(line({ status: "tasks", answer: "Bad role.", tasks: [{ role: "owner", work: "A" }] }), null);
  assert.equal(line({ status: "tasks", answer: "Too many.", tasks: Array.from({ length: 9 }, () => ({ role: "builder", work: "A" })) }), null);
});

test("a temporary failure retries on its own, then asks only when it keeps failing", async t => {
  const { board, notices, queue, dir, manifest } = setup(t);
  const row = queue("Fix the login bug");
  let clock = 1000;
  let calls = 0;
  const down = async () => { calls++; throw Object.assign(new Error("Claude Code could not run: token is refreshing"), { code: "AGENT_UNAVAILABLE" }); };
  const go = (runner, taskId) => dispatchBoardTask({ workspaceRoot: dir, board, manifest, notices, availability: { claude: true }, runner, now: () => clock, ...(taskId ? { taskId } : {}) });

  const first = await go(down, row.ID);
  assert.deepEqual([first.dispatched, first.reason, first.retryInMs], [false, "RETRY_SCHEDULED", 60000]);
  assert.equal(board.findTask(row.ID).Status, "Open");
  assert.equal(notices.listOpen().length, 0, "the owner is not asked about a hiccup");
  assert.match(board.findTask(row.ID)["Latest note"], /Trying again in 1 minute\./);
  assert.equal(board.getMeta(row.ID).progress.at(-1).stage, "retrying");

  // Until the minute is up the row is left alone, and other work is not blocked behind it.
  assert.equal((await go(down)).reason, "NO_OPEN_TASKS");
  assert.equal(calls, 1);

  clock += 60001;
  const second = await go(async ({ mode }) => mode === "read"
    ? { status: "Waiting on User", result: "delegate", answer: "Sending it to a builder.", delegation: { role: "builder", work: "Fix the login bug" } }
    : { status: "Done", answer: "Fixed." });
  assert.equal(second.status, "Done");

  // Three misses in a row and it stops and says so.
  const stuck = queue("Fix the signup bug");
  for (const wait of [60000, 120000, 300000]) {
    assert.equal((await go(down, stuck.ID)).retryInMs, wait);
    clock += wait + 1;
  }
  const last = await go(down, stuck.ID);
  assert.equal(last.status, "Waiting on User");
  assert.equal(notices.listOpen().some(n => n.row === stuck.ID && n.choices[0].label === "Try again"), true);
});

test("an open-task question answers locally without an agent or audit", async t => {
  const { board, queue, run } = setup(t);
  board.addTask({ task: "Finish the login button", to: "claude" });
  const row = queue("What tasks are at hand?");
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
    makeSheetTasks({ manifest: supplied }) {
      assert.equal(supplied.board.sheets.boardId, "fake-board");
      return { configured: true, listOpen: async () => [
        { id: "P4", task: "Shared task", to: "Muse", status: "Open" },
      ] };
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
  assert.deepEqual(meta.progress.map(p => p.stage), ["queued", "fallback", "planning", "completed"]);
  assert.deepEqual(auditOffers(board), []);
});

test("Muse clarifies, keeps the answer on one row, and hands clear coding to the builder", async t => {
  const { board, notices, manifest, queue, run } = setup(t);
  const row = queue("Fix the login bug");
  assert.equal(row.To, "muse");
  await run(row, async ({ agent, mode, prompt }) => {
    assert.equal(agent, "claude");
    assert.equal(mode, "read");
    assert.match(prompt, /You are Muse/);
    return { status: "Waiting on User", result: "clarify", question: "Which login bug?" };
  });
  assert.equal(board.findTask(row.ID).Status, "Waiting on User");
  assert.equal(board.getMeta(row.ID).awaitingReply, true);
  assert.equal(notices.listOpen().length, 0, "clarification is a free-text reply, not approval");
  const reply = { taskId: row.ID, text: "The sign-in button spins forever", turn: 1, board, manifest };
  replyToOrganizer(reply);
  assert.throws(() => replyToOrganizer(reply), { code: "STALE_REPLY" });
  const roles = [];
  await run(row, async ({ agent, mode, prompt }) => {
    roles.push([agent, mode]);
    assert.match(prompt, /sign-in button spins forever/);
    if (mode === "read") return { status: "Waiting on User", result: "delegate", answer: "I’ll send the fix to a builder.",
      delegation: { role: "builder", work: "Fix the sign-in button and test it" } };
    assert.match(prompt, /Fix the sign-in button and test it/);
    return { status: "Done", answer: "Fixed and verified with the login test." };
  });
  assert.deepEqual(roles, [["claude", "read"], ["claude", "write"]]);
  assert.equal(board.getMeta(row.ID).progress.some(event => event.stage === "delegated"), true);
  // The delegated build is checked without anyone asking for it.
  assert.equal(board.listTasks().length, 2);
  assert.equal(board.getMeta(board.listTasks()[1].ID).auditOf, row.ID);
  assert.deepEqual(auditOffers(board), []);
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
  const row = queue("Help me plan a login fix");
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
  const agy = findHarness("antigravity").run.args({ mode: "read", cwd: "C:\\work" });
  assert.equal(agy[agy.indexOf("--mode") + 1], "plan");
  // The Gemini command line is not an agent. Anything still assigned to it goes to Antigravity.
  assert.equal(findHarness("gemini").id, "antigravity");
  assert.equal(require("../lib/harness-registry.cjs").HARNESSES.some(h => h.id === "gemini"), false);
  assert.ok(findHarness("cursor").run.args({ mode: "read" }).includes("--mode=ask"));
  assert.ok(!findHarness("cursor").run.args({ mode: "read" }).includes("--force"));
});

test("Claude's session limit causes a bounded switch to another headless agent", async t => {
  const { board, queue, run } = setup(t);
  const row = queue("Help me plan next week");
  const calls = [];
  await run(row, options => {
    calls.push(options.agent);
    const output = options.agent === "claude"
      ? "You've hit your session limit · resets 5:40pm (America/Chicago)"
      : 'AIOS-RESULT: {"status":"completed","answer":"Here is a plan."}';
    return defaultCliRunner({ ...options, detect: () => [{ id: options.agent, workerPath: options.agent + ".exe" }],
      spawnFn: fakeSpawn(output) });
  });
  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(board.findTask(row.ID).Status, "Done");
  assert.equal(board.getMeta(row.ID).executor, "codex");
  assert.equal(board.getMeta(row.ID).progress.some(event => event.stage === "unavailable" && event.agent === "claude"), true);
});


test("an organizer cannot mark a requested code change done without a worker", async t => {
  const { board, queue, run } = setup(t);
  const row = queue("Fix the login bug");
  await run(row, async () => ({ status: "Done", answer: "I fixed it." }));
  assert.equal(board.findTask(row.ID).Status, "Waiting on User");
  assert.match(board.getMeta(row.ID).answer, /without handing off/);
  assert.deepEqual(auditOffers(board), []);
});


test("Muse offers to add a task when the connected Sheet has none", async t => {
  const { board, manifest } = setup(t);
  manifest.board = { mode: "sheets" };
  const result = await summarizeOpenTasks({
    board, manifest, requestId: "P1", task: "What tasks are at hand?",
    makeSheetTasks: () => ({ configured: true, listOpen: async () => [] }),
  });
  assert.equal(result.answer, "Connected Google Sheet\nNone currently. Want to add a task?");
});

test("explicit capture without a connected Sheet holds safely without launching an agent", async t => {
  const { board, queue, run } = setup(t);
  const row = queue("Add a task to send the receipt");
  await run(row);
  const meta = board.getMeta(row.ID);
  assert.equal(meta.intent, "sheet_task");
  assert.equal(board.findTask(row.ID).Status, "Waiting on User");
  assert.match(meta.answer, /Connect your Google Sheet/);
  assert.match(meta.sheetRequestId, /^[0-9a-f-]{36}$/);
});
