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
    return { state, post };
  }

  const first = await start();
  assert.equal(await first.state(), queued.ID);
  notices.raise({ row: asking.ID, kind: "approval", text: "Approve this fixture?" });
  assert.equal(await first.state(), queued.ID);
  assert.equal((await first.post(asking.ID, "https://other.example")).status, 403);
  for (const invalid of ["P999", hidden.ID, 3, undefined]) assert.equal((await first.post(invalid)).status, 400);
  assert.equal(fs.existsSync(file), false);

  assert.deepEqual(await first.post(asking.ID), { status: 200, ok: true, focus: asking.ID });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved), ["focus", "at"]);
  assert.equal(saved.focus, asking.ID);
  assert.ok(Number.isFinite(Date.parse(saved.at)));
  const restarted = await start();
  assert.equal(await restarted.state(), asking.ID);
  assert.deepEqual(await restarted.post(null), { status: 200, ok: true, focus: null });
  assert.equal(await (await start()).state(), null);
  assert.equal(fs.readFileSync(board.jsonPath, "utf8"), boardBefore);
});
