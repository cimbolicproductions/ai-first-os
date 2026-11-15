"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { dispatchBoardTask, queueOrganizerRequest, replyToOrganizer, usageBackAt } = require("../lib/os-runtime.cjs");
const { createCloudLink } = require("../lib/cloud-link.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-questions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const board = createLocalBoard({ boardDir: dir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const notices = createNoticeBook({ dir });
  const manifest = {
    board: { mode: "local", localDir: dir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "claude", researcher: "antigravity", auditor: "codex" },
  };
  const ask = (row, question, title) => dispatchBoardTask({
    workspaceRoot: dir, board, manifest, notices, availability: { claude: true }, taskId: row.ID, projects: [],
    runner: async () => ({ status: "Waiting on User", result: "clarify", question, displayTitle: title }),
  });
  return { dir, board, notices, manifest, ask };
}

test("the organizer's question reaches the owner as a card, and a newer one replaces it", async t => {
  const { board, notices, manifest, ask } = setup(t);
  const row = queueOrganizerRequest({ board, manifest, task: "Can you build me a website that makes me money please" });
  await ask(row, "How should the site make money?");
  const [first] = notices.listOpen();
  assert.deepEqual([first.row, first.kind, first.reply, first.text], [row.ID, "question", true, "How should the site make money?"]);

  replyToOrganizer({ taskId: row.ID, text: "Sell something I have", turn: 1, board, manifest, notices });
  assert.equal(notices.get(first.id).answer.value, "replied");
  await ask(row, "Which thing do you want to sell?");
  assert.deepEqual(notices.listOpen().map(n => n.text), ["Which thing do you want to sell?"], "only the latest question is open");

  // A very long question still fits on the phone's card; the whole of it stays in the conversation.
  const long = "Tell me more. ".repeat(120);
  replyToOrganizer({ taskId: row.ID, text: "Washer rentals", turn: 3, board, manifest, notices });
  await ask(row, long);
  const card = notices.listOpen()[0];
  assert.ok(card.text.length <= 1000 && card.text.endsWith("…"));
  assert.equal(board.getMeta(row.ID).conversation.at(-1).text, long);
});

test("an answer typed on the phone goes to the question it names, once", async t => {
  const { board, notices, manifest, ask } = setup(t);
  const row = queueOrganizerRequest({ board, manifest, task: "Can you build me a website that makes me money please" });
  await ask(row, "How should the site make money?", "Build a revenue site");
  const queue = [];
  const sent = [];
  const link = createCloudLink({
    relayUrl: "https://relay.example", homeToken: "home", board, notices, manifest,
    makeSheetTasks: () => ({ configured: false }),
    async fetchFn(url, { body }) {
      const route = new URL(url).pathname.split("/").at(-1);
      if (route === "pull") return new Response(JSON.stringify({ items: queue, push: [] }));
      sent.push([route, body ? JSON.parse(body) : null]);
      return new Response("{}");
    },
  });
  // First the phone gets the card, marked as one answered in words.
  assert.equal(await link.tick(), true);
  assert.ok(sent.some(([route, body]) => route === "notice" && body.notice.reply === true && body.notice.row === row.ID && body.notice.displayTitle === "Build a revenue site"));
  queue.push({ id: "r1", kind: "request", body: { text: `Reply for ${row.ID.toLowerCase()}: a local lead site`, to: null } });
  await link.tick();
  const meta = board.getMeta(row.ID);
  assert.deepEqual(meta.conversation.map(m => [m.role, m.text]), [["muse", "How should the site make money?"], ["user", "a local lead site"]]);
  assert.equal(board.findTask(row.ID).Status, "Open", "the organizer takes it from here");
  assert.equal(notices.listOpen().length, 0);
  // Then the phone is told the card is settled.
  assert.ok(sent.some(([route, body]) => route === "resolve"));
  assert.equal(board.listTasks().length, 1, "an answer never becomes a new request");

  // The relay hands the same message over again until it is acknowledged: taken once.
  await link.tick();
  assert.equal(board.getMeta(row.ID).conversation.length, 2);

  // An answer that arrives after the request moved on changes nothing, and says so.
  queue.splice(0, 1, { id: "r2", kind: "request", body: { text: `Reply for ${row.ID}: actually ads`, to: null } });
  await link.tick();
  assert.equal(board.getMeta(row.ID).conversation.length, 2);
  assert.ok(notices.listAll().some(n => n.text === `Your reply to ${row.ID} arrived after it had moved on, so nothing changed. Send it as a new request if it still matters.`));
  assert.equal(board.listTasks().length, 1);

  const page = fs.readFileSync(path.join(__dirname, "..", "phone", "index.html"), "utf8");
  assert.ok(page.includes('"Reply for " + n.row + ": " + words'));
});

test("an agent that says when its usage comes back is left alone until then", () => {
  const now = Date.parse("2026-11-14T19:00:00");
  const back = usageBackAt(`Codex could not run: purchase more credits or try again at Nov 16th, 2026 7:47 AM."}`, now);
  assert.equal(new Date(back).getDate(), 16);
  assert.equal(new Date(back).getHours(), 7);
  assert.equal(usageBackAt("try again later", now), null);
  assert.equal(usageBackAt("try again at Dec 30th, 2026 7:47 AM.", now), null, "only a time within the week");
  assert.equal(usageBackAt("try again at Nov 1st, 2026 7:47 AM.", now), null, "never a time already past");
});

test("every agent that is not ready has something to press", async t => {
  const { dir, board, manifest } = setup(t);
  const detected = [
    { id: "antigravity", label: "Antigravity", state: "signed-in", signedIn: true, authVerified: false, headless: true, binaryPath: "agy", workerPath: "agy" },
    { id: "cursor", label: "Cursor", state: "installed", signedIn: false, headless: false, binaryPath: "cursor", idePath: "cursor" },
    { id: "claude", label: "Claude Code", state: "signed-in", signedIn: true, authVerified: true, headless: true, binaryPath: "claude", workerPath: "claude" },
  ];
  const signedInto = [];
  const server = createDesktopServer({ workspaceRoot: dir, manifest, board, detect: () => detected, signIn: agent => { signedInto.push(agent.id); return { ok: true }; } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

  const { agents } = await (await fetch(`${base}/api/agents`)).json();
  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  assert.equal(byId.antigravity.state, "unverified");
  assert.equal(byId.cursor.getUrl, "https://cursor.com/cli", "a desktop-only agent links to where its command line is had");
  // A sign-in that could not be confirmed can be done again; a confirmed one is left alone.
  assert.equal((await post("/api/intro/signin", { agent: "antigravity" })).ok, true);
  assert.equal((await post("/api/intro/signin", { agent: "claude" })).ok, false);
  assert.deepEqual(signedInto, ["antigravity"]);
  assert.equal((await post("/api/agents/retry", { agent: "codex" })).ok, true);

  // The page draws a button for each case.
  const page = await (await fetch(base)).text();
  assert.ok(page.includes(`agent.state === "installed" || agent.state === "unverified"`));
  assert.ok(page.includes(`"Try again"`));
  assert.ok(page.includes(`"Get its command line"`));
});
