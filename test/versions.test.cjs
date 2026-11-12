"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { answerNotice, dispatchBoardTask } = require("../lib/os-runtime.cjs");
const { addVersionNote, versionView } = require("../lib/versions.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");

function setup(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-versions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boardDir = path.join(dir, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = {
    board: { mode: "local", localDir: boardDir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "codex", auditor: "claude", researcher: "antigravity" },
    settings,
  };
  const notices = createNoticeBook({ dir: boardDir });
  const availability = { claude: true, codex: true };
  const go = (taskId, runner) => dispatchBoardTask({ workspaceRoot: dir, board, manifest, notices, taskId, runner, availability, projects: [] });
  const done = (extra = {}) => async () => ({ status: "Done", note: "Finished.", ...extra });
  const open = () => board.listTasks({ status: "Open" });
  return { dir, board, manifest, notices, availability, go, done, open };
}

test("version 1 is shown, notes and the review are combined into version 2, and it runs to clean without stopping", async t => {
  const { board, notices, go, done, open } = setup(t);
  board.addTask({ task: "Build the bakery site", to: "codex" });
  await go("P1", done({ note: "Home page and menu are up." }));

  // Version 1 is there to look at while Claude checks what Codex built.
  const ready = notices.listOpen().find(n => n.row === "P1");
  assert.match(ready.text, /Codex finished: Build the bakery site\. Claude Code is checking it\. Version 1 is ready to look at/);
  assert.deepEqual(versionView(board, "P1"), { version: 1, canNote: true, notes: 0, review: "running", builder: "Codex" });

  // The owner talks while the review runs. Nothing starts yet: the note waits for the review.
  const noted = addVersionNote({ board, rowId: "P1", text: "Make the hero photo bigger" });
  assert.deepEqual([noted.waiting, noted.started], [true, null]);
  assert.equal(versionView(board, "P1").notes, 1);

  const audit = open()[0];
  assert.equal(audit.To, "claude");
  await go(audit.ID, done({ findings: ["The order form has no input validation", "Menu images have no alt text"] }));

  // One task for version 2, holding both lists, back to the same builder.
  const v2 = open();
  assert.equal(v2.length, 1);
  assert.deepEqual([v2[0].To, v2[0].Task], ["codex", "Version 2 of P1: 2 fixes from the review and 1 note from you"]);
  const brief = board.getMeta(v2[0].ID).delegatedWork;
  assert.match(brief, /From the outside review of the last version:\n1\. The order form has no input validation\n2\. Menu images have no alt text/);
  assert.match(brief, /the owner's note wins:\n1\. Make the hero photo bigger/);
  assert.equal(notices.listOpen().some(n => /Codex is building version 2 with your note too\./.test(n.text)), true);
  assert.equal(notices.listOpen().some(n => n.choices.length), false, "it did not stop to ask");

  let prompt = "";
  await go(v2[0].ID, async input => { prompt = input.prompt; return { status: "Done", note: "Validation added, alt text added, hero is larger." }; });
  assert.match(prompt, /Make the hero photo bigger/);
  assert.equal(notices.listOpen().some(n => /^Version 2 of P1 is built\. Validation added/.test(n.text)), true);
  assert.equal(versionView(board, "P1").version, 2);

  // Version 2 is checked on its own, and comes back clean.
  const recheck = open()[0];
  assert.equal(board.getMeta(recheck.ID).auditOf, "P1");
  await go(recheck.ID, done({ clean: true }));
  assert.equal(versionView(board, "P1").review, "clean");
  assert.deepEqual(open(), []);

  // Later the owner wants more. Nothing is running, so the note itself starts version 3.
  const later = addVersionNote({ board, rowId: "P1", text: "Add a catering page" });
  assert.equal(later.started.version, 3);
  assert.equal(open()[0].Task, "Version 3 of P1: 1 note from you");
  assert.throws(() => addVersionNote({ board, rowId: "P1", text: "   " }), e => e.code === "INVALID_NOTE");
});

test("with the switch off it shows the review, waits for the owner's notes, and builds on their word", async t => {
  const { board, manifest, notices, availability, go, done, open } = setup(t, { keepGoing: false });
  board.addTask({ task: "Build the bakery site", to: "codex" });
  await go("P1", done());
  await go(open()[0].ID, done({ findings: ["No input validation"] }));

  assert.deepEqual(open(), [], "nothing is built until the owner says so");
  const ask = notices.listOpen().find(n => n.choices.length);
  assert.match(ask.text, /Version 1 of P1 is checked\. The review found 1 thing: \(1\) No input validation Add your own notes if you want, then build version 2\./);
  assert.deepEqual(ask.choices.map(choice => choice.label), ["Build version 2"]);
  assert.equal(versionView(board, "P1").review, "reviewed");

  addVersionNote({ board, rowId: "P1", text: "Use warmer colors" });
  assert.deepEqual(open(), [], "a note alone does not start it either");
  const answered = answerNotice({ noticeId: ask.id, value: "build", digest: ask.digest, notices, board, manifest, availability });
  assert.equal(answered.version.version, 2);
  const brief = board.getMeta(open()[0].ID).delegatedWork;
  assert.match(brief, /1\. No input validation/);
  assert.match(brief, /1\. Use warmer colors/);
});

test("the note box, the switch and the single screen are there in the app", async t => {
  const { dir, board, manifest, go, done } = setup(t);
  board.addTask({ task: "Build the bakery site", to: "codex" });
  await go("P1", done());
  let saved = 0;
  const server = createDesktopServer({ workspaceRoot: dir, manifest, board, detect: () => [], onSaveManifest: () => { saved++; } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) }).then(r => r.json());
  const state = async () => (await fetch(`${base}/api/state`)).json();

  assert.deepEqual((await state()).taskMeta.P1.version, { version: 1, canNote: true, notes: 0, review: "running", builder: "Codex" });
  assert.deepEqual(await post("/api/note", { taskId: "P1", text: "Bigger logo" }), { ok: true, waiting: true, version: null });
  assert.equal((await state()).taskMeta.P1.version.notes, 1);

  assert.equal((await state()).crew.keepGoing, true);
  assert.equal((await post("/api/crew", { keepGoing: false })).ok, true);
  assert.deepEqual([(await state()).crew.keepGoing, saved], [false, 1]);

  const html = await (await fetch(base)).text();
  assert.match(html, /<button id="modeBtn" aria-pressed="false" hidden>/, "there is no detailed view to switch to");
  assert.match(html, /Don’t stop till it’s done/);
});
