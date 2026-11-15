"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { continuePlan, continueTask, GO_AHEAD } = require("../lib/continue-task.cjs");
const { buildWorkOrderPrompt, dispatchBoardTask } = require("../lib/os-runtime.cjs");
const { queueOrganizerRequest } = require("../lib/request-flow.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");

const MIN = 60 * 1000;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-continue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boardDir = path.join(dir, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const notices = createNoticeBook({ dir: boardDir });
  const manifest = {
    board: { localDir: boardDir }, ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "codex", auditor: "claude", researcher: "antigravity" },
    priorities: { builder: ["codex", "opencode"] },
  };
  return { dir, board, notices, manifest };
}

/** A build that one agent tried and could not finish, the way the runtime leaves it. */
function failedBuild({ board, notices }) {
  const row = board.addTask({ task: "Build a site that makes money and is fun", to: "opencode", meta: { role: "builder", kind: "build", progress: [] } });
  board.updateByColumnName({
    taskId: row.ID, agent: "opencode", columns: { Status: "Waiting on User" },
    note: "jetski: a tool needed the command permission that headless mode cannot prompt for.",
    meta: { executor: "opencode", answer: "The agent didn’t confirm a result. Check the task before trying again.", progress: [{ stage: "failed", at: new Date().toISOString(), agent: "opencode" }] },
  });
  notices.raise({ row: row.ID, kind: "blocked", text: "The agent didn’t confirm a result.", choices: [{ label: "Try again", value: "retry" }], then: { type: "reopen", row: row.ID } });
  return row;
}

test("Continue says what it will do, and never stands in for the owner's yes, no or choice", t => {
  const { board, notices, manifest } = setup(t);
  const available = { codex: true, opencode: true, claude: true };
  const plan = id => continuePlan({ row: board.findTask(id), meta: board.getMeta(id), notices: notices.listOpen(), manifest, availability: available });

  const failed = failedBuild({ board, notices });
  assert.deepEqual(plan(failed.ID), { action: "handoff", to: "codex" });

  const asking = board.addTask({ task: "Plan my week", to: "muse", meta: { role: "orchestrator", musePhase: "organize" } });
  board.updateByColumnName({ taskId: asking.ID, columns: { Status: "Waiting on User" }, meta: { awaitingReply: true, conversation: [{ role: "muse", text: "Which days?" }] } });
  assert.equal(plan(asking.ID).action, "go-ahead");

  const approval = board.addTask({ task: "Send the invoice", to: "muse" });
  board.updateByColumnName({ taskId: approval.ID, columns: { Status: "Waiting on User" } });
  notices.raise({ row: approval.ID, kind: "approval", text: "Approve this external action?", choices: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] });
  assert.equal(plan(approval.ID).action, "wait");

  const choice = board.addTask({ task: "Put it online", to: "codex" });
  board.updateByColumnName({ taskId: choice.ID, columns: { Status: "Waiting on User" } });
  notices.raise({ row: choice.ID, kind: "question", text: "Keep it private on GitHub?", choices: [{ label: "Private", value: "private" }, { label: "Skip", value: "skip" }] });
  assert.deepEqual(plan(choice.ID), { action: "wait", text: "Keep it private on GitHub?" });

  const queued = board.addTask({ task: "Queued work", to: "codex" });
  assert.equal(plan(queued.ID).action, "none");

  // With only the agent that had it last free, it goes back to that one; with nobody free, it says so.
  assert.deepEqual(continuePlan({ row: board.findTask(failed.ID), meta: board.getMeta(failed.ID), notices: notices.listOpen(), manifest, availability: { opencode: true } }), { action: "handoff", to: "opencode" });
  assert.equal(continuePlan({ row: board.findTask(failed.ID), meta: board.getMeta(failed.ID), notices: notices.listOpen(), manifest, availability: {} }).action, "wait");
});

test("a running task is only offered Continue once it has gone quiet", t => {
  const { board, manifest } = setup(t);
  const row = board.addTask({ task: "Build it", to: "codex", meta: { role: "builder" } });
  board.claimTask({ taskId: row.ID, agent: "codex", meta: { executor: "codex", startedAt: new Date().toISOString() } });
  const at = minutesAgo => new Date(Date.now() - minutesAgo * MIN).toISOString();
  const plan = lastSeenAt => continuePlan({ row: board.findTask(row.ID), meta: board.getMeta(row.ID), manifest, availability: { codex: true, opencode: true }, lastSeenAt });
  assert.equal(plan(at(0.2)).action, "none");
  assert.deepEqual(plan(at(5)).action, "stop-and-handoff");
  assert.equal(plan(at(5)).to, "opencode");
});

test("handing over carries what happened so far to the next agent and settles the Try again card", t => {
  const { board, notices, manifest } = setup(t);
  const row = failedBuild({ board, notices });
  return continueTask({ board, manifest, notices, taskId: row.ID, availability: { codex: true, opencode: true } }).then(result => {
    assert.deepEqual([result.ok, result.action, result.to], [true, "handoff", "codex"]);
    const after = board.findTask(row.ID);
    const meta = board.getMeta(row.ID);
    assert.deepEqual([after.Status, after.To], ["Open", "codex"]);
    assert.equal(meta.continuation.from, "opencode");
    assert.match(meta.continuation.lastWords, /headless mode cannot prompt/);
    assert.equal(meta.progress.at(-1).stage, "continued");
    assert.equal(notices.listOpen().filter(n => n.row === row.ID && !n.answer).length, 0);

    const prompt = buildWorkOrderPrompt(after, manifest, meta);
    assert.match(prompt, /## Continuing earlier work/);
    assert.match(prompt, /OpenCode/);
    assert.match(prompt, /git status and git diff/);
    assert.match(prompt, /headless mode cannot prompt/);
  });
});

test("Continue on a question tells the organizer to go ahead, as the owner's own reply", async t => {
  const { board, notices, manifest } = setup(t);
  const row = queueOrganizerRequest({ task: "Make me a site that earns money", board, manifest });
  board.updateByColumnName({ taskId: row.ID, columns: { Status: "Waiting on User" },
    meta: { awaitingReply: true, conversation: [{ role: "muse", text: "Who is it for?" }] } });
  const result = await continueTask({ board, manifest, notices, taskId: row.ID, availability: { codex: true } });
  assert.equal(result.action, "go-ahead");
  const meta = board.getMeta(row.ID);
  assert.deepEqual(meta.conversation.at(-1), { ...meta.conversation.at(-1), role: "user", text: GO_AHEAD });
  assert.equal(meta.awaitingReply, false);
  assert.equal(board.findTask(row.ID).Status, "Open");
});

test("a quiet run is stopped on its own, without pausing the queue, then handed over", { timeout: 15000 }, async t => {
  const { dir, board, notices, manifest } = setup(t);
  const row = board.addTask({ task: "Build the landing page", to: "codex", meta: { role: "builder", kind: "build" } });
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const runner = ({ signal }) => {
    started();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const run = dispatchBoardTask({ workspaceRoot: dir, manifest, board, notices, taskId: row.ID, runner, availability: { codex: true, opencode: true } });
  await running;
  assert.equal(board.findTask(row.ID).Status, "In progress");
  // Five minutes from now it has said nothing: Continue stops this run only and hands it on.
  const later = () => Date.now() + 5 * MIN;
  const result = await continueTask({ board, manifest, notices, taskId: row.ID, availability: { codex: true, opencode: true }, now: later, pollMs: 50 });
  await run;
  assert.deepEqual([result.ok, result.action, result.to], [true, "handoff", "opencode"]);
  assert.equal(board.queueState().paused, false);
  assert.deepEqual([board.findTask(row.ID).Status, board.findTask(row.ID).To], ["Open", "opencode"]);
  assert.match(board.getMeta(row.ID).continuation.why, /went quiet/);

  // An old stop request never stops the next run.
  let finished = false;
  await dispatchBoardTask({ workspaceRoot: dir, manifest, board, notices, taskId: row.ID, availability: { opencode: true },
    runner: async () => { finished = true; return { status: "Done", note: "Finished." }; } });
  assert.equal(finished, true);
  assert.equal(board.findTask(row.ID).Status, "Done");
  assert.equal(board.getMeta(row.ID).continuation, null);
});

test("the desktop shows what Continue will do and runs it from the app's own page only", async t => {
  const { dir, board, notices, manifest } = setup(t);
  const row = failedBuild({ board, notices });
  const runs = [];
  const server = createDesktopServer({
    workspaceRoot: dir, manifest, board, notices,
    runner: async ({ agent }) => { runs.push(agent); return { status: "Done", note: "Finished." }; },
    detect: () => [{ id: "codex", installed: true, signedIn: true, headless: true }],
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const view = await (await fetch(base + "/api/state")).json();
  assert.deepEqual(view.taskMeta[row.ID].next, { action: "handoff", to: "Codex" });
  assert.match(view.taskMeta[row.ID].lastNote, /headless mode/);
  const post = (body, origin = base) => fetch(base + "/api/continue", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  assert.equal((await post({ taskId: row.ID }, "https://evil.example")).status, 403);
  const result = await (await post({ taskId: row.ID })).json();
  assert.equal(result.ok, true);
  for (let i = 0; i < 40 && board.findTask(row.ID).Status !== "Done"; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(board.findTask(row.ID).Status, "Done");
  assert.deepEqual(runs, ["codex"]);
});
