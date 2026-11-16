"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");
const { nextForOwner, pickFocus } = require("../lib/focus.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { dispatchBoardTask } = require("../lib/os-runtime.cjs");

const now = Date.parse("2026-11-15T21:00:00Z");
const minutesAgo = minutes => new Date(now - minutes * 60_000).toISOString();
const row = (ID, Status, minutes = 1) => ({ ID, Status, Updated: minutesAgo(minutes) });

test("restoring focus respects an explicit choice, expiry, and the fallback order", () => {
  const tasks = [
    row("P1", "Open"),
    row("P2", "Waiting on User", 20),
    row("P3", "Waiting on User", 5),
    row("P4", "In progress"),
    row("P5", "Waiting on User"),
    row("P6", "Done"),
    row("P7", "Done", 11),
    row("P8", "Waiting on Dom"),
  ];
  const taskMeta = { P5: { awaitingReply: true }, P8: { putAway: true } };
  const notices = [
    { row: "P8", kind: "approval", created: minutesAgo(40) },
    { row: "P3", kind: "approval", created: minutesAgo(19), answer: { value: "no" } },
    { row: "P2", reply: true, created: minutesAgo(15) },
  ];
  const sample = { tasks, taskMeta, notices, now };
  assert.equal(nextForOwner(sample), "P2");
  assert.equal(nextForOwner({ ...sample, exclude: "P2" }), "P5");
  assert.equal(pickFocus(sample), "P2");
  assert.equal(pickFocus({ ...sample, saved: { focus: "P4" } }), "P4");
  assert.equal(pickFocus({ ...sample, saved: { focus: "P6" } }), "P6");
  assert.equal(pickFocus({ ...sample, saved: { focus: null } }), null);
  for (const focus of ["P7", "P8", "missing"]) {
    assert.equal(pickFocus({ ...sample, saved: { focus } }), "P2");
  }
  assert.equal(pickFocus({ ...sample, tasks: tasks.slice(0, 4), notices: [] }), "P4");
  assert.equal(pickFocus({ ...sample, tasks: tasks.slice(0, 3), notices: [] }), "P3");
  assert.equal(pickFocus({ ...sample, tasks: tasks.slice(0, 1), notices: [] }), "P1");
  assert.equal(pickFocus({ ...sample, tasks: tasks.slice(5, 7), notices: [] }), null);
});

test("desktop focus is local, validated, durable, and leaves the board and runner alone", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-focus-"));
  const board = createLocalBoard({ boardDir: dir });
  const notices = createNoticeBook({ dir });
  board.initBoard([], { empty: true });
  const queued = board.addTask({ task: "Queued fixture" });
  const asking = board.addTask({ task: "Question fixture" });
  const hidden = board.addTask({ task: "Put away fixture" });
  board.updateByColumnName({ taskId: hidden.ID, agent: "Router", columns: { Status: "Done" } });
  board.setPutAway(hidden.ID, true);
  const boardBefore = fs.readFileSync(board.jsonPath, "utf8");
  const file = path.join(dir, "ui.json");
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    const server = createDesktopServer({
      manifest: { roles: {} }, board, notices, workspaceRoot: dir,
      detect: () => [], runner: () => assert.fail("Focus started an agent"),
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const state = async () => (await fetch(base + "/api/state").then(response => response.json())).focus;
    const post = async (taskId, origin = base) => {
      const response = await fetch(base + "/api/focus", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      return { status: response.status, ...(await response.json()) };
    };
    const answer = async (notice, digest = notice.digest) => {
      const response = await fetch(base + "/api/answer", {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ noticeId: notice.id, digest, value: "no" }),
      });
      return { status: response.status, ...(await response.json()) };
    };
    return { state, post, answer };
  }

  const first = await start();
  assert.equal(await first.state(), queued.ID);
  const approval = notices.raise({ row: asking.ID, kind: "approval", text: "Approve this fixture?",
    choices: [{ label: "No", value: "no" }] });
  assert.equal(await first.state(), queued.ID);
  assert.deepEqual(await first.answer(approval), { status: 409, ok: false, error: "Open that request first." });
  assert.equal(notices.get(approval.id).answer, null);
  const signIn = notices.raise({ kind: "question", text: "Open this setup fixture?", choices: [{ label: "No", value: "no" }] });
  assert.equal((await first.answer(signIn)).status, 200);
  assert.equal((await first.post(asking.ID, "https://other.example")).status, 403);
  for (const invalid of ["P999", hidden.ID, 3, undefined]) assert.equal((await first.post(invalid)).status, 400);
  assert.equal(fs.existsSync(file), false);

  assert.deepEqual(await first.post(asking.ID), { status: 200, ok: true, focus: asking.ID });
  assert.equal((await first.answer(approval, "outdated")).status, 409);
  assert.equal(notices.get(approval.id).answer, null);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved), ["focus", "at"]);
  assert.equal(saved.focus, asking.ID);
  assert.ok(Number.isFinite(Date.parse(saved.at)));
  const restarted = await start();
  assert.equal(await restarted.state(), asking.ID);
  assert.equal(fs.readFileSync(board.jsonPath, "utf8"), boardBefore);
  assert.equal((await restarted.answer(approval)).status, 200);
  assert.deepEqual(await restarted.post(null), { status: 200, ok: true, focus: null });
  assert.equal(await (await start()).state(), null);
});

test("notes follow their request, and an external action gets its own approval", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-focus-note-"));
  const board = createLocalBoard({ boardDir: dir });
  const notices = createNoticeBook({ dir });
  const manifest = { roles: { builder: "codex", orchestrator: "codex" } };
  board.initBoard([], { empty: true });
  const queued = board.addTask({ task: "Build the fixture", to: "codex" });
  const finished = board.addTask({ task: "Read the existing fixture" });
  board.updateByColumnName({ taskId: finished.ID, agent: "Router", columns: { Status: "Done" }, meta: { answer: "Original answer." } });
  const server = createDesktopServer({ manifest, board, notices, workspaceRoot: dir, detect: () => [] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => fetch(origin + route, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then(response => response.json());
  await post("/api/focus", { taskId: queued.ID });
  assert.equal((await post("/api/note", { taskId: finished.ID, text: "Wrong focus", mode: "finished" })).ok, false);
  assert.equal((await post("/api/note", { taskId: queued.ID, text: "x".repeat(4001), mode: "later" })).ok, false);
  assert.equal((await post("/api/note", { taskId: queued.ID, text: "Use the sample data", mode: "later" })).ok, true);
  const gated = await post("/api/note", { taskId: queued.ID, text: "Also publish it", mode: "later" });
  assert.equal(board.getMeta(gated.followUp.ID).intent, "external_action");
  assert.equal(board.getMeta(gated.followUp.ID).followUpOf, queued.ID);
  await dispatchBoardTask({ workspaceRoot: dir, manifest, board, notices, taskId: gated.followUp.ID,
    runner: () => assert.fail("A gated note started a worker") });
  assert.ok(notices.listOpen().some(notice => notice.kind === "approval" && notice.row === gated.followUp.ID));

  await dispatchBoardTask({ workspaceRoot: dir, manifest, board, notices, taskId: queued.ID, runner: async ({ prompt }) => {
    assert.match(prompt, /Use the sample data/);
    assert.doesNotMatch(prompt, /Also publish it/);
    assert.equal((await post("/api/note", { taskId: queued.ID, text: "Keep this for later", mode: "later" })).ok, true);
    return { status: "Done", note: "Built the fixture." };
  } });
  assert.equal(board.findTask(queued.ID).Task, queued.Task);
  assert.deepEqual(board.getMeta(queued.ID).ownerNotes, ["Keep this for later"]);

  await post("/api/focus", { taskId: finished.ID });
  const follow = await post("/api/note", { taskId: finished.ID, text: "What did you conclude?", mode: "finished" });
  assert.equal(board.getMeta(follow.followUp.ID).followUpOf, finished.ID);
  let seenPrompt = "";
  await dispatchBoardTask({ workspaceRoot: dir, manifest, board, notices, taskId: follow.followUp.ID, runner: async ({ prompt }) => {
    seenPrompt = prompt;
    return { status: "Done", note: "Answered." };
  } });
  assert.match(seenPrompt, /Read the existing fixture/);
  assert.match(seenPrompt, /Original answer/);
});
