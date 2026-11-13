"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { answerNotice, dispatchBoardTask, queueOrganizerRequest, replyToOrganizer } = require("../lib/os-runtime.cjs");
const { parseRequestResult } = require("../lib/request-flow.cjs");
const { slug, shipVersion } = require("../lib/ship.cjs");

/** Stand-ins for git, GitHub and Vercel that record every call. Nothing real is touched. */
function fakeTools({ github = true, vercel = true, alias = false } = {}) {
  const calls = [];
  const signIn = { github, vercel };
  let hasRemote = false;
  async function run(tool, args, options = {}) {
    calls.push({ tool, args, cwd: options.cwd || null });
    const line = `${tool} ${args.join(" ")}`;
    if (line === "git init" && options.cwd) {
      fs.mkdirSync(path.join(options.cwd, ".git"), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    if (line === "git remote get-url origin") return { code: hasRemote ? 0 : 2, stdout: "", stderr: "" };
    if (line === "gh auth status") return { code: signIn.github ? 0 : 1, stdout: "", stderr: "" };
    if (line === "vercel whoami") return { code: signIn.vercel ? 0 : 1, stdout: "", stderr: "" };
    if (line.startsWith("gh repo create")) { hasRemote = true; return { code: 0, stdout: "", stderr: "" }; }
    if (line.startsWith("gh repo view")) return { code: 0, stdout: "https://github.com/owner/bakery-site\n", stderr: "" };
    if (line === "vercel deploy --prod --yes") return {
      code: 0, stdout: "https://bakery-site-abc123.vercel.app\n",
      stderr: "Inspect: https://vercel.com/x [2s]\nProduction: https://bakery-site-abc123.vercel.app [9s]\n" + (alias ? "Aliased: https://bakery-site.vercel.app [9s]\n" : ""),
    };
    return { code: 0, stdout: "", stderr: "" };
  }
  return { run, calls, signIn, lines: () => calls.map(call => `${call.tool} ${call.args.join(" ")}`) };
}

function setup(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-ship-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boardDir = path.join(dir, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = {
    projectsHome: path.join(dir, "projects"),
    board: { mode: "local", localDir: boardDir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "codex", auditor: "claude", researcher: "antigravity" },
    settings,
  };
  const notices = createNoticeBook({ dir: boardDir });
  const availability = { claude: true, codex: true };
  return { dir, board, manifest, notices, availability };
}

test("a new idea gets its own folder, and a clean version goes to GitHub and the web only on the owner's yes", async t => {
  const { dir, board, manifest, notices, availability } = setup(t);
  const tools = fakeTools();
  let saved = 0;
  const options = { workspaceRoot: dir, board, manifest, notices, availability, projects: [], shipRun: tools.run, saveManifest: () => { saved++; } };
  const row = queueOrganizerRequest({ board, manifest, task: "Build me a website" });
  const cwds = [];
  const runner = async ({ mode, cwd, prompt }) => {
    cwds.push(cwd);
    if (mode === "read" && /This Is An Audit/.test(prompt)) return { status: "Done", note: "Looked.", clean: true };
    if (mode === "read") {
      assert.match(prompt, /"new_project":"short-name"/);
      return { status: "Waiting on User", result: "delegate", answer: "Starting a new project.", delegation: { role: "builder", work: "Build the bakery site", newProject: "bakery-site" } };
    }
    return { status: "Done", answer: "Home page is up." };
  };
  await dispatchBoardTask({ ...options, taskId: row.ID, runner });
  replyToOrganizer({ taskId: row.ID, text: "Online orders for my bakery. Customers. They can order.", turn: board.getMeta(row.ID).conversation.length, board, manifest });
  await dispatchBoardTask({ ...options, taskId: row.ID, runner });

  // The folder exists, has its own history, is remembered, and is where the builder worked.
  const folder = path.join(dir, "projects", "bakery-site");
  assert.equal(fs.statSync(folder).isDirectory(), true);
  assert.deepEqual(manifest.projects, [{ name: "bakery-site", path: folder, repo: null, createdByOs: true }]);
  assert.deepEqual(tools.calls[0], { tool: "git", args: ["init"], cwd: folder });
  assert.equal(cwds.at(-1), folder);
  assert.equal(board.getMeta(row.ID).project, "bakery-site");

  // The outside review comes back clean. It is saved, and then it asks before anything leaves the computer.
  fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
  const audit = board.listTasks({ status: "Open" })[0];
  await dispatchBoardTask({ ...options, taskId: audit.ID, runner });
  assert.ok(tools.lines().includes("git add -A"));
  assert.equal(fs.readFileSync(path.join(folder, ".git", "AIOS_COMMIT_MESSAGE"), "utf8"), "Version 1\n");
  assert.equal(tools.lines().some(line => /^gh repo create|^git push|^vercel deploy/.test(line)), false);
  const askGithub = notices.listOpen().find(n => n.settingKey === "settings.ship.github");
  assert.match(askGithub.text, /on your GitHub, as private repositories only you can see\?/);

  const yes = answerNotice({ noticeId: askGithub.id, value: "yes", notices, board, manifest, shipRun: tools.run });
  await yes.shipping;
  assert.ok(tools.lines().includes("gh repo create bakery-site --private --source . --remote origin --push"));
  assert.equal(notices.listOpen().some(n => n.text === "Version 1 of bakery-site is on your GitHub, private. https://github.com/owner/bakery-site"), true);
  assert.equal(manifest.projects[0].repo, "owner/bakery-site");

  // Going online is asked for this project by name, because anyone with the link can open it.
  assert.equal(tools.lines().includes("vercel deploy --prod --yes"), false);
  const askOnline = notices.listOpen().find(n => n.then?.type === "online");
  assert.match(askOnline.text, /Put bakery-site online .* anyone who has the link can open it\./);
  const online = answerNotice({ noticeId: askOnline.id, value: "yes", notices, board, manifest, shipRun: tools.run });
  await online.shipping;
  assert.equal(manifest.projects[0].online, "yes");
  assert.equal(notices.listOpen().some(n => n.text === "Version 1 of bakery-site is online. https://bakery-site-abc123.vercel.app"), true);
  assert.equal(board.getMeta(row.ID).liveUrl, "https://bakery-site-abc123.vercel.app");

  // Once it is online, one offer of its own address. Asked once per project.
  const offer = notices.listOpen().find(n => n.then?.type === "domain");
  assert.match(offer.text, /Give bakery-site its own web address, instead of bakery-site-abc123\.vercel\.app\? .*Nothing is bought unless you buy it yourself\./);
  assert.deepEqual(offer.choices.map(c => c.value), ["find", "no"]);
  assert.equal(manifest.projects[0].domain, "offered");

  // Nothing the owner or an agent wrote ever reached a command line.
  const everyArgument = tools.calls.flatMap(call => call.args).join(" ");
  assert.doesNotMatch(everyArgument, /website|bakery site|Home page|orders/i);
  assert.ok(saved >= 1, "the new project is written to the workspace file");
});

test("a project the owner already had is never pushed or put online by this", async t => {
  const { dir, board, manifest, notices } = setup(t, { ship: { github: "yes" } });
  const tools = fakeTools();
  manifest.projects = [{ name: "client-site", path: path.join(dir, "client-site"), repo: "owner/client-site" }];
  board.addTask({ task: "Fix the footer", to: "codex", meta: { kind: "build", project: "client-site" } });
  assert.deepEqual(await shipVersion({ board, root: "P1", manifest, notices, run: tools.run }), { skipped: true });
  assert.deepEqual(tools.calls, []);
});

test("when GitHub is not connected, the sign-in happens in the app and the work carries on by itself", async t => {
  const { dir, board, manifest, notices } = setup(t, { ship: { github: "yes" } });
  const tools = fakeTools({ github: false });
  const folder = path.join(dir, "projects", "bakery-site");
  fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
  manifest.projects = [{ name: "bakery-site", path: folder, repo: null, createdByOs: true, online: "no" }];
  board.addTask({ task: "Build the bakery site", to: "codex", meta: { kind: "build", project: "bakery-site" } });

  assert.equal((await shipVersion({ board, root: "P1", manifest, notices, run: tools.run })).needs, "github");
  const connect = notices.listOpen().find(n => n.then?.type === "connect");
  assert.deepEqual(connect.choices, [{ label: "Connect GitHub", value: "connect:github" }]);
  assert.match(connect.text, /You approve it in your browser/);

  // A stand-in for the sign-in: it shows its page and code, then the owner approves.
  let approve;
  const started = [];
  const answered = answerNotice({
    noticeId: connect.id, value: "connect:github", notices, board, manifest, shipRun: tools.run,
    connect: (service, { onPrompt }) => {
      started.push(service);
      onPrompt({ link: "https://github.com/login/device", code: "ABCD-1234" });
      return new Promise(resolve => { approve = resolve; });
    },
  });
  assert.deepEqual(started, ["github"]);
  const prompt = notices.listOpen().find(n => n.kind === "connect");
  assert.equal(prompt.link, "https://github.com/login/device");
  assert.match(prompt.text, /enter the code ABCD-1234. This carries on by itself once you approve./);
  assert.deepEqual(prompt.choices, [], "nothing to click but the link");

  tools.signIn.github = true;
  approve({ ok: true });
  await answered.connecting;
  assert.equal(notices.listOpen().some(n => n.kind === "connect"), false, "the link goes away once used");
  assert.equal(notices.listOpen().some(n => n.text === "Connected to GitHub."), true);
  assert.ok(tools.lines().includes("gh repo create bakery-site --private --source . --remote origin --push"), "and the push that was waiting happened");

  // Not approved in time: one plain question to start it again.
  board.setMeta("P1", { shippedVersion: null });
  manifest.projects[0].repo = null;
  tools.signIn.github = false;
  await shipVersion({ board, root: "P1", manifest, notices, run: tools.run });
  const again = notices.listOpen().find(n => n.then?.type === "connect");
  const late = answerNotice({ noticeId: again.id, value: "connect:github", notices, board, manifest, shipRun: tools.run, connect: async () => ({ ok: false, reason: "expired" }) });
  await late.connecting;
  const retry = notices.listOpen().find(n => /was not approved in time/.test(n.text));
  assert.deepEqual(retry.choices, [{ label: "Connect GitHub", value: "connect:github" }]);
});

test("the owner gets the short Vercel address when there is one, not the long one that can need a sign-in", async t => {
  const { dir, board, manifest, notices } = setup(t, { ship: { github: "no" } });
  const folder = path.join(dir, "projects", "bakery-site");
  fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
  manifest.projects = [{ name: "bakery-site", path: folder, repo: null, createdByOs: true, online: "yes" }];
  board.addTask({ task: "Build the bakery site", to: "codex", meta: { kind: "build", project: "bakery-site" } });
  assert.equal((await shipVersion({ board, root: "P1", manifest, notices, run: fakeTools({ alias: true }).run })).liveUrl, "https://bakery-site.vercel.app");
  board.setMeta("P1", { onlineVersion: null });
  assert.equal((await shipVersion({ board, root: "P1", manifest, notices, run: fakeTools().run })).liveUrl, "https://bakery-site-abc123.vercel.app");
});

test("project names become safe folder names, or are refused", () => {
  assert.equal(slug("Bakery Site!"), "bakery-site");
  assert.equal(slug("../../etc/passwd"), "etc-passwd");
  assert.equal(slug("x"), null);
  assert.equal(slug("   "), null);
  const parsed = parseRequestResult('AIOS-RESULT: {"status":"delegate","answer":"New.","role":"builder","work":"Build it","new_project":"My Bakery Site"}');
  assert.equal(parsed.delegation.newProject, "my-bakery-site");
});
