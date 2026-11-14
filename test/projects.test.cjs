"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { answerNotice, dispatchBoardTask, queueOrganizerRequest } = require("../lib/os-runtime.cjs");
const { discoverProjects, resolveProject, projectNamedIn, repoFromRemote } = require("../lib/projects.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-projects-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = path.join(dir, "code");
  const repo = (name, remote) => {
    fs.mkdirSync(path.join(code, name, ".git"), { recursive: true });
    if (remote) fs.writeFileSync(path.join(code, name, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*\n`);
  };
  repo("washer-site", "https://someone:ghp_notARealToken@github.com/acme/washer-site.git");
  repo("point-of-sale", "git@github.com:acme/pos.git");
  repo("scratchpad", null);
  fs.mkdirSync(path.join(code, "not-a-project"), { recursive: true });
  const boardDir = path.join(dir, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = {
    board: { mode: "local", localDir: boardDir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "claude", researcher: "antigravity", auditor: "codex" },
    settings: {},
  };
  const projects = discoverProjects({ roots: [code] });
  const notices = createNoticeBook({ dir: boardDir });
  const go = (taskId, runner, extra = {}) => dispatchBoardTask({
    workspaceRoot: dir, board, manifest, notices, taskId, runner, projects, availability: { claude: true, codex: true }, ...extra,
  });
  return { dir, code, board, manifest, notices, projects, go };
}

test("projects are found on the computer, with their GitHub names and never their sign-in details", t => {
  const { code, projects } = setup(t);
  assert.deepEqual(projects.map(project => project.name).sort(), ["point-of-sale", "scratchpad", "washer-site"]);
  const washer = resolveProject("washer-site", projects);
  assert.deepEqual([washer.repo, washer.path], ["acme/washer-site", path.join(code, "washer-site")]);
  assert.doesNotMatch(JSON.stringify(projects), /ghp_|someone/);
  assert.equal(resolveProject("acme/pos", projects).name, "point-of-sale");
  assert.equal(resolveProject("pos", projects).name, "point-of-sale");
  assert.equal(resolveProject("../../etc", projects), null);
  assert.equal(projectNamedIn("fix the header on the washer site please", projects).name, "washer-site");
  assert.equal(projectNamedIn("fix the header", projects), null);
  assert.equal(repoFromRemote("https://example.com/not/a/known/host"), null);
});

test("the organizer picks the project, the builder works in that folder, and the check happens there too", async t => {
  const { dir, code, board, manifest, go } = setup(t);
  const row = queueOrganizerRequest({ board, manifest, task: "Fix the checkout button" });
  const runs = [];
  await go(row.ID, async ({ mode, cwd, prompt, subscriptionOnly }) => {
    runs.push({ mode, cwd, subscriptionOnly });
    if (mode === "read") {
      assert.match(prompt, /Projects on this computer/);
      assert.match(prompt, /- point-of-sale \(GitHub: acme\/pos\)/);
      return { status: "Waiting on User", result: "delegate", answer: "Sending it to a builder.", delegation: { role: "builder", work: "Fix the checkout button", project: "acme/pos" } };
    }
    assert.match(prompt, /You are working in point-of-sale \(GitHub: acme\/pos\)/);
    return { status: "Done", answer: "Fixed." };
  });
  assert.deepEqual(runs.map(run => run.cwd), [dir, path.join(code, "point-of-sale")]);
  assert.ok(runs.every(run => run.subscriptionOnly === true), "every run uses the subscription sign-in");
  assert.equal(board.getMeta(row.ID).project, "point-of-sale");

  // The audit that starts on its own runs in the same project.
  const audit = board.listTasks().at(-1);
  assert.equal(board.getMeta(audit.ID).auditOf, row.ID);
  let auditCwd = null;
  await go(audit.ID, async ({ cwd }) => { auditCwd = cwd; return { status: "Done", note: "Looked.", clean: true }; });
  assert.equal(auditCwd, path.join(code, "point-of-sale"));

  // A project the organizer made up is ignored. The owner's own words can name one.
  manifest.settings.autoAudit = false;
  const named = queueOrganizerRequest({ board, manifest, task: "Fix the footer on the washer site" });
  const where = [];
  await go(named.ID, async ({ mode, cwd }) => {
    where.push(cwd);
    return mode === "read"
      ? { status: "Waiting on User", result: "delegate", answer: "On it.", delegation: { role: "builder", work: "Fix the footer", project: "C:\\Windows" } }
      : { status: "Done", answer: "Fixed." };
  });
  assert.equal(where.at(-1), path.join(code, "washer-site"));
});

test("a paid key is never used without asking, and the answer is remembered", async t => {
  const { board, manifest, notices, go } = setup(t);
  manifest.settings.autoAudit = false;
  board.addTask({ task: "Tidy the notes", to: "claude" });
  const down = async () => { throw Object.assign(new Error("usage limit reached"), { code: "AGENT_UNAVAILABLE" }); };
  const result = await go("P1", down, { availability: { claude: true }, env: { OPENAI_API_KEY: "present" } });
  assert.equal(result.status, "Waiting on User");
  const ask = notices.listOpen().find(n => n.row === "P1");
  assert.match(ask.text, /costs money for every request/);
  assert.deepEqual(ask.choices.map(choice => choice.label), ["Keep to my subscription", "Use the paid key"]);

  answerNotice({ noticeId: ask.id, value: "subscription", notices, board, manifest });
  assert.equal(manifest.settings.usage, "subscription");
  assert.equal(board.findTask("P1").Status, "Open");
  let flag = null;
  await go("P1", async ({ subscriptionOnly }) => { flag = subscriptionOnly; return { status: "Done", note: "Tidied." }; }, { availability: { claude: true }, env: { OPENAI_API_KEY: "present" } });
  assert.equal(flag, true);

  manifest.settings.usage = "paid";
  board.addTask({ task: "Tidy again", to: "claude" });
  await go("P2", async ({ subscriptionOnly }) => { flag = subscriptionOnly; return { status: "Done", note: "Tidied." }; }, { availability: { claude: true } });
  assert.equal(flag, false);
});

test("with nobody signed in, the question itself opens the sign-in and the task starts on its own after", async t => {
  const { board, manifest, notices, go } = setup(t);
  board.addTask({ task: "First task", to: "claude" });
  const detect = () => [{ id: "claude", label: "Claude Code", state: "installed", installed: true, signedIn: false, headless: true, workerPath: "/bin/claude", binaryPath: "/bin/claude" }];
  await go("P1", async () => assert.fail("nobody is signed in"), { availability: { claude: false }, detect });
  const ask = notices.listOpen().find(n => n.row === "P1");
  assert.equal(ask.text, "No agent is signed in yet. Sign in to one and this starts on its own.");
  assert.deepEqual(ask.choices, [{ label: "Sign in to Claude Code", value: "signin:claude" }]);

  const opened = [];
  let finish;
  const answered = answerNotice({ noticeId: ask.id, value: "signin:claude", notices, board, manifest, detect, openSignIn: agent => { opened.push(agent.id); return { ok: true }; }, now: () => 1000,
    signInWatch: ({ id }) => new Promise(resolve => { assert.equal(id, "claude"); finish = resolve; }) });
  assert.deepEqual(opened, ["claude"]);
  assert.equal(board.findTask("P1").Status, "Open");
  assert.equal(board.getMeta("P1").retryAfter, 46000);
  // The moment the sign-in finishes, the task may start at once, and the owner is called back to the chat.
  finish(true);
  assert.equal(await answered.signedIn, true);
  assert.equal(board.getMeta("P1").retryAfter, null);
  const back = notices.listOpen().find(n => n.text === "Signed in to Claude Code. Your task is starting.");
  assert.equal(back?.back, true);
});
