"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");

const phonePage = fs.readFileSync(path.join(__dirname, "..", "phone", "index.html"), "utf8");

test("the phone is one box, one microphone and one button until a Sheet is connected", () => {
  // Everything above the Sheet section, which stays hidden until a Sheet answers.
  assert.match(phonePage, /<section id="sheetWrap" hidden>/);
  const body = phonePage.slice(phonePage.indexOf("<body>"), phonePage.indexOf('<section id="sheetWrap"'));
  const visibleButtons = [...body.matchAll(/<button\b([^>]*)>([^<]*)</g)]
    .filter(([, attrs]) => !/\bhidden\b/.test(attrs))
    .map(([, , label]) => label);
  assert.deepEqual(visibleButtons, ["Voice dump", "Send"]);

  // Nobody picks an agent or learns a format on the phone. The organizer routes.
  assert.doesNotMatch(phonePage, /id="agents"|Anyone|next task” between/);
  assert.match(phonePage, /call\("POST", "request", \{ text \}\)/);
  // The Sheet buttons appear only when the computer says a Sheet is connected.
  assert.match(phonePage, /\$\("saveTasks"\)\.hidden = \$\("viewTasks"\)\.hidden = !sheetAvailable;/);
});

test("the desktop leaves Sheet controls out until a Sheet is connected", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-surface-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const board = createLocalBoard({ boardDir: path.join(dir, "board"), routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = {
    board: { mode: "local", localDir: path.join(dir, "board") },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "claude", auditor: "codex", researcher: "gemini" },
  };
  const serve = async sheetTasks => {
    const server = createDesktopServer({ workspaceRoot: dir, manifest, board, detect: () => [], ...(sheetTasks ? { sheetTasks } : {}) });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return { state: await (await fetch(`${base}/api/state`)).json(), html: await (await fetch(base)).text() };
  };

  const plain = await serve(null);
  assert.equal(plain.state.sheetConnected, false);
  assert.match(plain.html, /id="addSheetTasksBtn" hidden/);
  assert.match(plain.html, /id="sheetTasksBtn" hidden/);
  assert.match(plain.html, /Say it or type it\./);

  const withSheet = await serve({ configured: true });
  assert.equal(withSheet.state.sheetConnected, true);
});
