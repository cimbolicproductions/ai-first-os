"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { buildDesktopHtml, createDesktopServer } = require("../lib/desktop-hud.cjs");
const { watchTaskBoard } = require("../lib/os-runtime.cjs");

async function setup(t, runner) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aios-queue-"));
  const boardDir = path.join(workspaceRoot, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = { board: { localDir: boardDir }, ideology: { routerFunnel: "Muse" }, roles: { builder: "claude" } };
  const server = createDesktopServer({ workspaceRoot, manifest, board, runner, detect: () => [] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, data) => (await fetch(url + route, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  })).json();
  return { workspaceRoot, boardDir, manifest, board, post };
}

test("stopping interrupts a managed run and pauses both dispatch paths until resume", { timeout: 10000 }, async t => {
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  let completed;
  const secondCompleted = new Promise(resolve => { completed = resolve; });
  const runner = async ({ task, signal }) => {
    if (task.ID !== "P1") return { status: "Done", note: "Finished." };
    started();
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const { workspaceRoot, boardDir, board, manifest, post } = await setup(t, runner);
  const otherBoard = createLocalBoard({ boardDir, routerName: "Muse" });
  const first = board.addTask({ task: "Build the sample page", to: "claude" });
  const second = board.addTask({ task: "Build the sample menu", to: "claude" });
  let stopped;
  const firstStopped = new Promise(resolve => { stopped = resolve; });
  const watcher = watchTaskBoard({
    workspaceRoot, manifest, board: otherBoard, runner, availability: { claude: true },
    onDispatch(result) {
      if (result.taskId === first.ID) stopped(result);
      if (result.taskId === second.ID) completed(result);
    },
  });
  t.after(() => watcher.close());
  await firstStarted;
  assert.equal((await post("/api/queue", { paused: true })).paused, true);
  assert.equal(otherBoard.queueState().paused, true);
  assert.throws(() => otherBoard.claimTask({ taskId: second.ID, agent: "claude" }), { code: "QUEUE_PAUSED" });
  assert.equal((await post("/api/run", { taskId: second.ID })).reason, "QUEUE_PAUSED");
  assert.equal((await firstStopped).status, "Waiting on User");
  assert.match(board.getMeta(first.ID).answer, /Stopped/);
  assert.equal(board.findTask(second.ID).Status, "Open");
  assert.equal((await post("/api/queue", { paused: false })).paused, false);
  assert.equal((await secondCompleted).status, "Done");
  assert.equal(board.findTask(first.ID).Status, "Waiting on User");
});

test("putting a request away is reversible and changes no task columns", async t => {
  const { board, boardDir, post } = await setup(t);
  const row = board.addTask({ task: "Build a sample page", to: "claude" });
  assert.equal((await post("/api/put-away", { taskId: row.ID, putAway: true })).code, "TASK_ACTIVE");
  const waiting = board.updateByColumnName({ taskId: row.ID, agent: "Muse", columns: { Status: "Waiting on User" } });
  assert.equal((await post("/api/put-away", { taskId: row.ID, putAway: true })).ok, true);
  const freshBoard = createLocalBoard({ boardDir, routerName: "Muse" });
  assert.equal(freshBoard.getMeta(row.ID).putAway, true);
  assert.deepEqual(freshBoard.findTask(row.ID), waiting);
  assert.equal((await post("/api/put-away", { taskId: row.ID, putAway: false })).ok, true);
  assert.equal(freshBoard.getMeta(row.ID).putAway, false);
  assert.deepEqual(freshBoard.findTask(row.ID), waiting);
  assert.doesNotThrow(() => new Function(buildDesktopHtml().match(/<script>([\s\S]*?)<\/script>/)[1]));
});
