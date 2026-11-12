"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { dispatchBoardTask, queueOrganizerRequest, replyToOrganizer } = require("../lib/os-runtime.cjs");
const { ordersGatedAction } = require("../lib/request-flow.cjs");
const { readBrief } = require("../lib/project-brief.cjs");
const { routeTask } = require("../lib/roles.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-brief-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boardDir = path.join(dir, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = {
    vaultPath: path.join(dir, "vault"),
    board: { mode: "local", localDir: boardDir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "claude", researcher: "antigravity", auditor: "codex" },
    settings: {},
  };
  const projects = [{ name: "bakery-site", path: path.join(dir, "bakery-site"), repo: "acme/bakery-site" }];
  const notices = createNoticeBook({ dir: boardDir });
  const go = (taskId, runner, extra = {}) => dispatchBoardTask({
    workspaceRoot: dir, board, manifest, notices, taskId, runner, projects, availability: { claude: true, codex: true }, ...extra,
  });
  return { dir, board, manifest, notices, projects, go };
}

const delegate = project => ({ status: "Waiting on User", result: "delegate", answer: "Sending it to a builder.", delegation: { role: "builder", work: "Build the site", project } });

test("a thin build request gets one question first, then the answer shapes the work", async t => {
  const { board, manifest, go } = setup(t);
  const row = queueOrganizerRequest({ board, manifest, task: "Build me a website" });
  let builds = 0;
  const runner = async ({ mode, prompt }) => {
    if (mode === "read") {
      assert.match(prompt, /what it is for, who will use it, and what finished looks like/);
      return delegate("bakery-site");
    }
    builds++;
    assert.match(prompt, /online orders for my bakery/);
    return { status: "Done", answer: "Built the order page." };
  };
  await go(row.ID, runner);
  assert.equal(builds, 0, "nothing is built on a guess");
  const meta = board.getMeta(row.ID);
  assert.equal(meta.awaitingReply, true);
  assert.equal(meta.answer, "Before I start: what is this for, who will use it, and what does finished look like?");

  replyToOrganizer({ taskId: row.ID, text: "It is for online orders for my bakery. Customers use it. Done means they can order and pay.", turn: meta.conversation.length, board, manifest });
  await go(row.ID, runner);
  assert.equal(builds, 1);

  // Describing a product is not an order to spend or send. Telling the organizer to do it is.
  assert.equal(ordersGatedAction("Customers use it. Done means they can order and pay."), false);
  assert.equal(ordersGatedAction("Looks good. Then publish it."), true);
  assert.equal(ordersGatedAction("Email the landlord about it"), true);

  // Said enough the first time, or switched off: straight to work.
  const clear = queueOrganizerRequest({ board, manifest, task: "Fix the broken checkout button on the bakery site so the total updates when the quantity changes" });
  await go(clear.ID, async ({ mode }) => mode === "read" ? delegate("bakery-site") : { status: "Done", answer: "Fixed." });
  assert.equal(board.getMeta(clear.ID).awaitingReply, false);
});

test("the vault holds one brief per project that any agent can pick up from", async t => {
  const { board, manifest, go } = setup(t);
  const row = queueOrganizerRequest({ board, manifest, task: "Fix the checkout button on the bakery site so totals update" });
  await go(row.ID, async ({ mode }) => mode === "read" ? delegate("bakery-site") : { status: "Done", answer: "Totals now update when the quantity changes. Tests pass." });

  let brief = readBrief(manifest, "bakery-site");
  assert.match(brief.file, /04_Projects[\\/]Active[\\/]bakery-site\.md$/);
  assert.deepEqual(brief.sections.Goal, ["Fix the checkout button on the bakery site so totals update"]);
  assert.match(brief.sections["Where it lives"].join("\n"), /GitHub: acme\/bakery-site/);
  assert.match(brief.sections.Log.at(-1), /P1 · Claude Code built: Totals now update/);
  assert.deepEqual(brief.sections.Next, ["Being checked by another agent. Nothing is needed from the owner."]);
  assert.equal(board.findTask(row.ID)["Spec file"], brief.file);

  // The check, the fix and the recheck each leave a line, and the next agent is pointed at the brief.
  const audit = board.listTasks().at(-1);
  let auditPrompt = "";
  await go(audit.ID, async ({ prompt }) => { auditPrompt = prompt; return { status: "Done", note: "Reviewed.", findings: ["Totals ignore tax"] }; });
  assert.match(auditPrompt, /## Project brief\nRead .*bakery-site\.md first/);
  brief = readBrief(manifest, "bakery-site");
  assert.match(brief.sections.Log.at(-1), /Codex checked and found: \(1\) Totals ignore tax/);
  assert.match(brief.sections.Next[0], /fixing what the check found/);

  const fix = board.listTasks({ status: "Open" })[0];
  await go(fix.ID, async () => ({ status: "Done", note: "Tax is now included." }));
  const recheck = board.listTasks({ status: "Open" })[0];
  await go(recheck.ID, async () => ({ status: "Done", note: "Looked again.", clean: true }));
  brief = readBrief(manifest, "bakery-site");
  assert.equal(brief.sections.Log.length, 4);
  assert.deepEqual(brief.sections.Next, ["Checked and clean. Nothing is open. Ask for the next change when ready."]);
  assert.deepEqual(brief.sections.Goal, ["Fix the checkout button on the bakery site so totals update"], "the goal is never overwritten");
});

test("first and second choice per role, saved from the quiet pickers under the box", async t => {
  const { dir, board, manifest } = setup(t);
  let saved = 0;
  const server = createDesktopServer({ workspaceRoot: dir, manifest, board, detect: () => [], onSaveManifest: () => { saved++; } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/api/crew`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) }).then(r => r.json());

  assert.deepEqual((await (await fetch(`${base}/api/state`)).json()).crew.priorities, { builder: ["claude"], researcher: ["antigravity"] });
  assert.equal((await post({ role: "builder", order: ["codex", "claude"] })).ok, true);
  assert.equal((await post({ role: "researcher", order: ["antigravity", "claude"] })).ok, true);
  assert.equal((await post({ organizer: "grokbot" })).ok, true);
  assert.equal((await post({ outsideReview: false })).ok, true);
  assert.equal((await post({ role: "builder", order: ["not-an-agent"] })).ok, false);
  assert.equal(saved, 4);

  const { crew } = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual([crew.organizer, crew.outsideReview], ["grokbot", false]);
  assert.deepEqual(crew.priorities, { builder: ["codex", "claude"], researcher: ["antigravity", "claude"] });
  assert.match(await (await fetch(base)).text(), /id="crewRow"/);

  // The order is what routing follows when the first choice is out.
  const out = { codex: false, claude: true, antigravity: false, cursor: true };
  assert.equal(routeTask({ assigned: "codex", manifest, availability: out, role: "builder" }).agent, "claude");
  assert.equal(routeTask({ assigned: "antigravity", manifest, availability: out, role: "researcher" }).agent, "claude");
});
