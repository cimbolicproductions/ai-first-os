"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { HARNESSES, findHarness, chooseFreeModel, olderThan, stopProcessTree, ownGroup, DEFAULT_FREE_MODEL } = require("../lib/harness-registry.cjs");
const { detectInstalledAgents } = require("../lib/agent-auth.cjs");
const { readCodexEvent, plainLine } = require("../lib/activity.cjs");
const { answerNotice, defaultCliRunner, dispatchBoardTask, queueOrganizerRequest, replyToOrganizer, buildWorkOrderPrompt } = require("../lib/os-runtime.cjs");
const { classifyOrganizerRequest, asksForDomain } = require("../lib/request-flow.cjs");
const { checkStep, onMoneyPage, createdTab, isJobPage, guardSettings, MAX_STEPS } = require("../lib/browser-guard.cjs");
const { domainStep, browserWorkOrder } = require("../lib/domains.cjs");
const { shipVersion, defaultRun, createProject } = require("../lib/ship.cjs");
const { installTool, installable, installCommand } = require("../lib/install.cjs");
const { createCloudLink } = require("../lib/cloud-link.cjs");
const { syncBoardSheet } = require("../lib/sheet-board.cjs");
const { addVersionNote } = require("../lib/versions.cjs");

/** A stand-in for the project tools. Its git init leaves a history behind, the way the real one does. */
async function gitInit(tool, args, options = {}) {
  if (tool === "git" && args[0] === "init" && options.cwd) {
    fs.mkdirSync(path.join(options.cwd, ".git"), { recursive: true });
    fs.writeFileSync(path.join(options.cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  return { code: 0, stdout: "", stderr: "" };
}

function setup(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-loose-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boardDir = path.join(dir, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = {
    projectsHome: path.join(dir, "projects"),
    board: { mode: "local", localDir: boardDir },
    ideology: { routerFunnel: "Muse" },
    roles: { orchestrator: "muse", builder: "claude", researcher: "antigravity", auditor: "codex" },
    settings,
  };
  const notices = createNoticeBook({ dir: boardDir });
  const go = (taskId, runner, extra = {}) => dispatchBoardTask({
    workspaceRoot: dir, board, manifest, notices, taskId, runner, projects: [], availability: { claude: true, codex: true }, ...extra,
  });
  return { dir, board, manifest, notices, go };
}

/** A stand-in process that prints the given text and exits. Records how it was started. */
function fakeProcess(replies) {
  const started = [];
  const spawnFn = (file, args, options) => {
    const reply = typeof replies === "function" ? replies(args, started.length) : replies;
    started.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.stdin = Object.assign(new EventEmitter(), { end(text) {
      started.at(-1).stdin = text;
      setImmediate(() => {
        if (reply.stdout) child.stdout.emit("data", reply.stdout);
        if (reply.stderr) child.stderr.emit("data", reply.stderr);
        child.emit("close", reply.code ?? 0);
      });
    } });
    child.kill = () => {};
    return child;
  };
  return { spawnFn, started };
}

test("a free agent is one more entry: no account, a free model picked from its own list, and too old means not offered work", () => {
  const spec = findHarness("opencode");
  assert.equal(spec.free, true);
  assert.equal(findHarness("deepseek").id, "opencode", "asking for DeepSeek by name lands on the agent that runs it for free");
  assert.deepEqual(spec.run.args({ mode: "write", model: null }), ["run", "--agent", "build", "-m", DEFAULT_FREE_MODEL]);
  assert.deepEqual(spec.run.args({ mode: "write", model: null, cwd: "C:\\site" }).slice(0, 3), ["run", "--dir", "C:\\site"], "its working folder is named outright");
  assert.equal(plainLine("← Write C:/Users/someone/site/hello.txt"), "Writing hello.txt");
  assert.equal(plainLine("$ npm test --token=abc"), null, "a line with a secret word is dropped whole");
  assert.equal(plainLine("$ npm run build"), "Running npm");
  assert.equal(plainLine("ERROR codex_models_manager::cache: failed to load models cache"), null);
  assert.equal(plainLine("> build · deepseek-v4.1-flash-free"), null);
  assert.deepEqual(spec.run.args({ mode: "read", model: "opencode/glm-5.3-flash-free" }), ["run", "--agent", "plan", "-m", "opencode/glm-5.3-flash-free"]);
  assert.equal(spec.run.promptVia, "stdin");

  // DeepSeek first, only free ones, and never one whose maker may learn from what is sent.
  const listing = "opencode/big-pickle\nopencode/mimo-v2.6-flash-free\nopencode/glm-5.3-flash-free\nopencode/deepseek-v4.1-flash-free\ngoogle/gemini-4-argon\nperplexity-agent/openai/gpt-6-sol\n";
  assert.equal(chooseFreeModel(listing), "opencode/deepseek-v4.1-flash-free");
  assert.equal(chooseFreeModel("opencode/mimo-v2.6-flash-free\nopencode/glm-5.3-flash-free"), "opencode/glm-5.3-flash-free");
  assert.equal(chooseFreeModel("google/gemini-4-argon\nopencode/big-pickle"), null);

  assert.equal(olderThan("1.1.53", "1.19.0"), true);
  assert.equal(olderThan("1.19.5", "1.19.0"), false);
  assert.equal(olderThan("opencode v2.0.1", "1.19.0"), false);
  assert.equal(olderThan("no version here", "1.19.0"), false, "an unreadable version is never called old");

  // Detected with no sign-in at all, and held back when the copy is too old to work.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aios-free-home-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const exe = path.join(bin, process.platform === "win32" ? "opencode.exe" : "opencode");
  fs.writeFileSync(exe, "");
  fs.chmodSync(exe, 0o755);
  const seen = version => detectInstalledAgents({ homeDir: home, env: { PATH: bin, Path: bin }, execProbe: () => ({ status: 0, stdout: version }) }).find(a => a.id === "opencode");
  const current = seen("1.19.5");
  assert.deepEqual([current.state, current.signedIn, current.headless, current.free, current.canInstall], ["signed-in", true, true, true, true]);
  const old = seen("1.1.53");
  assert.deepEqual([old.state, old.signedIn, old.headless, old.outdated], ["outdated", false, false, true]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("Codex shows what it is doing as it works, and its last message is the answer", async t => {
  const { dir } = setup(t);
  // These lines are from a real codex exec --json run.
  const real = [
    '{"type":"thread.started","thread_id":"01a1d55d"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Exceeded skills context budget."}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I am reading the file now."}}',
    '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"\\"C:\\\\\\\\Program Files (x86)\\\\\\\\PowerShell\\\\\\\\7\\\\\\\\pwsh.exe\\" -Command \\"Get-Content -LiteralPath .\\\\\\\\note.txt --token=abc\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"x","aggregated_output":"hello","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Read it.\\nAIOS-CLEAN"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
  ];
  assert.deepEqual(readCodexEvent(real[4]), { activity: "Running Get-Content" }, "the first word of the command, never its arguments");
  assert.equal(readCodexEvent(real[2]), null);
  assert.equal(readCodexEvent(real[5]), null);
  assert.deepEqual(readCodexEvent('{"type":"item.started","item":{"type":"file_change","changes":[{"path":"C:\\\\site\\\\index.html"}]}}'), { activity: "Writing index.html" });
  assert.equal(readCodexEvent("not json"), null);

  const proc = fakeProcess({ stdout: real.join("\n") + "\n" });
  const seen = [];
  const outcome = await defaultCliRunner({
    agent: "codex", prompt: "check it", cwd: dir, task: { ID: "P1" }, mode: "read",
    detect: () => [{ id: "codex", workerPath: path.join(dir, "codex.exe") }], spawnFn: proc.spawnFn, onActivity: words => seen.push(words),
  });
  assert.ok(proc.started[0].args.includes("--json"));
  assert.equal(proc.started[0].stdin, "check it", "the prompt goes in over stdin");
  assert.ok(seen.includes("Running Get-Content"));
  assert.equal(outcome.clean, true);
  assert.equal(outcome.note, "Read it.");
});

test("when the account cannot use the model an agent is set to, it switches to one that works instead of failing", async t => {
  const { dir } = setup(t);
  const refused = '{"type":"error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}\n';
  const fine = '{"type":"item.completed","item":{"type":"agent_message","text":"Built it."}}\n';
  const proc = fakeProcess((args, n) => (n === 0 ? { stdout: refused, code: 1 } : { stdout: fine, code: 0 }));
  const outcome = await defaultCliRunner({
    agent: "codex", prompt: "p", cwd: dir, task: { ID: "P1" }, detect: () => [{ id: "codex", workerPath: path.join(dir, "codex.exe") }], spawnFn: proc.spawnFn,
  });
  assert.equal(proc.started.length, 2);
  assert.equal(proc.started[0].args.includes("--model"), false);
  assert.equal(proc.started[1].args[proc.started[1].args.indexOf("--model") + 1], findHarness("codex").run.fallbackModels[0]);
  assert.equal(outcome.note, "Built it.");

  // A model the owner chose is theirs: no quiet switch, the agent is reported unavailable so another can take the work.
  const pinned = fakeProcess({ stdout: refused, code: 1 });
  await assert.rejects(defaultCliRunner({
    agent: "codex", prompt: "p", cwd: dir, task: { ID: "P1" }, model: "gpt-6.1-sol", detect: () => [{ id: "codex", workerPath: path.join(dir, "codex.exe") }], spawnFn: pinned.spawnFn,
  }), error => error.code === "AGENT_UNAVAILABLE");
  assert.equal(pinned.started.length, 1);
});

test("the free agent reads its own list of free models once, and a real agent never starts from a test", async t => {
  const { dir } = setup(t);
  const workerPath = path.join(dir, "opencode-" + Date.now() + ".exe");
  const proc = fakeProcess(args => (args.includes("models")
    ? { stdout: "opencode/big-pickle\nopencode/glm-5.3-flash-free\nopencode/deepseek-v9-flash-free\n" }
    : { stdout: "Wrote the page.\n" }));
  const run = () => defaultCliRunner({ agent: "opencode", prompt: "build it", cwd: dir, task: { ID: "P1" }, detect: () => [{ id: "opencode", workerPath }], spawnFn: proc.spawnFn });
  assert.equal((await run()).note, "Wrote the page.");
  await run();
  const runs = proc.started.filter(start => start.args.includes("run"));
  assert.equal(proc.started.filter(start => start.args.includes("models")).length, 1, "the list is read once, not before every task");
  assert.deepEqual(runs.map(start => start.args[start.args.indexOf("-m") + 1]), ["opencode/deepseek-v9-flash-free", "opencode/deepseek-v9-flash-free"]);
  assert.equal(runs[0].stdin, "build it");

  // No stand-in passed: the real thing is refused rather than started.
  await assert.rejects(defaultCliRunner({ agent: "claude", prompt: "p", cwd: dir, task: { ID: "P1" }, detect: () => [{ id: "claude", workerPath: path.join(dir, "claude.exe") }] }),
    error => error.code === "AGENT_UNAVAILABLE" && /do not run during tests/.test(error.message));
});

test("the browser fence keeps a job to one tab, one page and two nameservers, and refuses what it cannot read", async () => {
  const tool = name => "mcp__claude-in-chrome__" + name;
  const name = "bakerysite.co";
  const home = "https://ap.www.namecheap.com/domains/domaincontrolpanel/bakerysite.co/domain";
  const at = (state, action, input) => checkStep({ tool: tool(action), input, name, state });

  // The one page, compared after the address is parsed. A crafted address that only starts the same is refused.
  assert.equal(isJobPage(home, name), true);
  for (const url of [
    home + "/../../other.com/domain", "https://ap.www.namecheap.com/domains/domaincontrolpanel/other.com/../bakerysite.co/domain",
    home + "?x=1", home + "#x", home + "/", home + ".evil.example/x", "https://evil.example/?" + home,
    "https://user@ap.www.namecheap.com/domains/domaincontrolpanel/bakerysite.co/domain", "http://ap.www.namecheap.com/domains/domaincontrolpanel/bakerysite.co/domain",
    "https://ap.www.namecheap.com:8443/domains/domaincontrolpanel/bakerysite.co/domain", "https://ap.www.namecheap.com/domains/domaincontrolpanel/other.com/domain",
    "https://www.namecheap.com/shoppingcart/", "back", "",
  ]) assert.equal(isJobPage(url, name), false, url);

  // Nothing happens before the job has its own tab, and nothing is read or clicked before its page is open.
  assert.equal(at({}, "navigate", { url: home, tabId: 7 }).allow, false);
  assert.equal(at({}, "read_page", { tabId: 7 }).allow, false);
  assert.equal(at({}, "tabs_context_mcp", { createIfEmpty: true }).allow, true);
  assert.equal(at({}, "tabs_create_mcp", {}).allow, true);
  assert.equal(at({ tab: "7" }, "tabs_create_mcp", {}).allow, false, "one tab per job");
  assert.equal(at({ tab: "7" }, "read_page", { tabId: 7 }).allow, false, "the page is not open yet");
  assert.equal(at({ tab: "7" }, "computer", { action: "left_click", coordinate: [1, 2], tabId: 7 }).allow, false);
  const opened = at({ tab: "7" }, "navigate", { url: home, tabId: 7 });
  assert.deepEqual([opened.allow, opened.state], [true, { steps: 1, tab: "7", opened: true, looks: 0 }]);

  // The tab list is read at most twice, and never once the job has its own tab.
  assert.deepEqual(at({}, "tabs_context_mcp", {}).state.looks, 1);
  assert.equal(at({ looks: 2 }, "tabs_context_mcp", {}).allow, false);
  assert.match(at({ tab: "7" }, "tabs_context_mcp", {}).why, /does not need to list the others/);
  assert.equal(at({ tab: "7" }, "navigate", { url: "https://www.namecheap.com/shoppingcart/", tabId: 7 }).allow, false);

  // Every other tab is out of reach: reading it, clicking in it, sending it somewhere, or closing it.
  const ready = { tab: "7", opened: true, steps: 3 };
  for (const [action, input] of [["read_page", { tabId: 8 }], ["get_page_text", {}], ["find", { tabId: "8", query: "x" }],
    ["computer", { action: "left_click", coordinate: [1, 2], tabId: 8 }], ["navigate", { url: home, tabId: 8 }], ["tabs_close_mcp", { tabId: 8 }], ["form_input", { value: "ns1.vercel-dns.com" }]]) {
    assert.equal(at(ready, action, input).allow, false, action + " on another tab");
  }
  assert.equal(at(ready, "read_page", { tabId: 7 }).allow, true);
  assert.equal(at(ready, "tabs_close_mcp", { tabId: 7 }).allow, true);

  // In its tab: the two nameservers and plain clicks, and nothing else.
  assert.equal(at(ready, "computer", { action: "type", text: "ns1.vercel-dns.com", tabId: 7 }).allow, true);
  assert.equal(at(ready, "form_input", { value: "NS2.VERCEL-DNS.COM.", tabId: 7 }).allow, true);
  for (const typedText of ["4111 1111 1111 1111", "hunter2", "ns1.vercel-dns.com.evil.example", ""]) {
    assert.equal(at(ready, "computer", { action: "type", text: typedText, tabId: 7 }).allow, false, typedText);
    assert.equal(at(ready, "form_input", { value: typedText, tabId: 7 }).allow, false, typedText);
  }
  assert.equal(at(ready, "computer", { action: "left_click", coordinate: [1, 2], tabId: 7 }).allow, true);
  assert.equal(at(ready, "computer", { action: "key", text: "ctrl+a", tabId: 7 }).allow, true);
  for (const input of [{ action: "key", text: "ctrl+v" }, { action: "right_click" }, { action: "left_click_drag" }, {}]) assert.equal(at(ready, "computer", { ...input, tabId: 7 }).allow, false);
  for (const action of ["javascript_tool", "file_upload", "upload_image", "something_new"]) assert.equal(at(ready, action, { tabId: 7 }).allow, false, action);
  assert.equal(at({ ...ready, steps: MAX_STEPS }, "read_page", { tabId: 7 }).allow, false, "a job that wanders runs out of steps");

  // Fail closed: a tool that is not a browser tool, no tool at all, or no valid domain is refused, never waved through.
  for (const odd of ["ToolSearch", "", undefined, "Bash"]) assert.equal(checkStep({ tool: odd, input: {}, name, state: ready }).allow, false, String(odd));
  assert.equal(checkStep({ tool: tool("read_page"), input: { tabId: 7 }, name: "not a domain", state: ready }).allow, false);

  // After a step: landing where money moves stops the whole job, and the tab a job opens is read from what came back.
  assert.equal(onMoneyPage({ tool: tool("computer"), response: [{ type: "text", text: "Clicked. Tab is now at https://www.namecheap.com/shoppingcart/checkout" }] }), true);
  assert.equal(onMoneyPage({ tool: tool("navigate"), response: "Navigated to " + home }), false);
  assert.equal(onMoneyPage({ tool: tool("read_page"), response: "link https://www.namecheap.com/cart/ Renew" }), false, "a link on a page is not a visit");
  assert.equal(createdTab([{ type: "text", text: "Created new tab. Tab ID: 1203948571" }]), "1203948571");
  assert.equal(createdTab({ tabId: 77123 }), "77123");
  assert.equal(createdTab("nothing useful"), null);

  // The settings Claude Code loads. A path that could mean something to a shell is refused, not escaped.
  const stateFile = path.join(os.tmpdir(), "aios-guard-test-" + process.pid + ".json");
  const settings = guardSettings({ name, counterFile: stateFile });
  assert.deepEqual(Object.keys(settings.hooks), ["PreToolUse", "PostToolUse"]);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "mcp__claude-in-chrome__.*");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /browser-guard\.cjs" bakerysite\.co "/);
  assert.throws(() => guardSettings({ name: "x.co; rm -rf", counterFile: stateFile }), error => error.code === "BAD_NAME");
  assert.ok(guardSettings({ name, counterFile: "C:\\Users\\José Núñez\\AppData\\Local\\Temp\\g.json" }));
  for (const bad of ["C:\\Users\\a!b\\g.json", "/tmp/a^b.json", "/tmp/a\nb.json", "/tmp/$(touch x).json", "/tmp/`id`.json", "C:\\Users\\%USERNAME%\\g.json", 'C:\\a"b.json', "/tmp/a;b.json", "/tmp/a&b.json"]) {
    assert.throws(() => guardSettings({ name, counterFile: bad }), error => error.code === "UNSAFE_COMMAND_LINE", bad);
  }
  const claude = findHarness("claude").browser;
  assert.equal(claude.guarded, true);
  assert.deepEqual(claude.args({ settingsFile: "C:\\tmp\\g.json" }).slice(4, 6), ["--settings", "C:\\tmp\\g.json"]);

  // Run as Claude Code runs it, a whole job in order. Exit code 2 is the one that blocks a step.
  const script = path.join(__dirname, "..", "lib", "browser-guard.cjs");
  fs.rmSync(stateFile, { force: true });
  const hook = (event, file = stateFile) => spawnSync(process.execPath, [script, name, file], { input: typeof event === "string" ? event : JSON.stringify(event), encoding: "utf8" });
  const before = (action, input) => hook({ hook_event_name: "PreToolUse", tool_name: tool(action), tool_input: input });
  const after = (action, response) => hook({ hook_event_name: "PostToolUse", tool_name: tool(action), tool_response: response });
  assert.equal(before("navigate", { url: home, tabId: 4242 }).status, 2, "no tab of its own yet");
  assert.equal(before("tabs_create_mcp", {}).status, 0);
  assert.equal(after("tabs_create_mcp", [{ type: "text", text: "Created new tab. Tab ID: 4242" }]).status, 0);
  const wrongTab = before("navigate", { url: home, tabId: 9999 });
  assert.equal(wrongTab.status, 2);
  assert.match(wrongTab.stderr, /Work only in the tab this job opened \(tab 4242\)/);
  const cart = before("navigate", { url: "https://www.namecheap.com/cart", tabId: 4242 });
  assert.equal(cart.status, 2);
  assert.match(cart.stderr, /Only https:\/\/ap\.www\.namecheap\.com/);
  assert.equal(before("navigate", { url: home, tabId: 4242 }).status, 0);
  assert.equal(before("computer", { action: "type", text: "ns1.vercel-dns.com", tabId: 4242 }).status, 0);
  assert.equal(before("computer", { action: "type", text: "4111111111111111", tabId: 4242 }).status, 2);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).steps, 3, "only steps that were allowed are counted");
  assert.equal(JSON.parse(after("navigate", "now at https://www.namecheap.com/checkout").stdout).continue, false);
  // Unreadable input, a broken state file, or no state file at all: refused.
  assert.equal(hook("not json at all").status, 2);
  fs.writeFileSync(stateFile, "{broken", "utf8");
  assert.equal(before("read_page", { tabId: 4242 }).status, 2);
  // Two checks at the same moment cannot both use the last look at the tab list.
  fs.rmSync(stateFile, { force: true });
  const looks = Array.from({ length: 6 }, () => require("node:child_process").spawn(process.execPath, [script, name, stateFile], { stdio: ["pipe", "ignore", "ignore"] }));
  for (const child of looks) child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool("tabs_context_mcp"), tool_input: {} }));
  const codes = [];
  for (const child of looks) codes.push(await new Promise(resolve => child.on("close", resolve)));
  assert.equal(codes.filter(code => code === 0).length, 2, "exactly two looks, however many arrive together");
  assert.equal(fs.existsSync(stateFile + ".lock"), false);
  fs.rmSync(stateFile, { force: true });
  assert.equal(spawnSync(process.execPath, [script, name], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool("tabs_context_mcp"), tool_input: {} }), encoding: "utf8" }).status, 2);
  fs.rmSync(stateFile, { force: true });
});

function fakeRegistry(nameservers = {}) {
  return async url => {
    if (url === "https://api.ipify.org") return new Response("203.0.113.7");
    if (url === "https://data.iana.org/rdap/dns.json") return new Response(JSON.stringify({ services: [[["co", "com"], ["https://rdap.example/"]]] }));
    const name = String(url).replace("https://rdap.example/domain/", "");
    if (nameservers[name]) return new Response(JSON.stringify({ nameservers: nameservers[name].map(ldhName => ({ ldhName })) }));
    return new Response("{}", { status: 404 });
  };
}
const VERCEL = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"];
const OTHER = ["dns1.registrar-servers.com", "dns2.registrar-servers.com"];
const claudeAgent = { id: "claude", label: "Claude Code", path: "/bin/claude", browser: findHarness("claude").browser };
const codexAgent = { id: "codex", label: "Codex", path: "/bin/codex", browser: findHarness("codex").browser };
const bought = { type: "domain", step: "bought", project: "bakery-site", row: "P1", name: "bakerysite.co" };

function domainSetup(t, nameservers, settings = {}) {
  const { dir, notices } = setup(t);
  const manifest = { settings, projects: [{ name: "bakery-site", path: path.join(dir, "bakery-site"), createdByOs: true, online: "yes" }] };
  const tools = [];
  const jobs = [];
  const deps = {
    fetchFn: fakeRegistry(nameservers), readSecret: () => null, pollMs: 1, verifyMs: 0, sleep: async () => {},
    run: async (tool, args) => { tools.push(`${tool} ${args.join(" ")}`); return { code: 0, stdout: "", stderr: "" }; },
  };
  return { notices, manifest, project: manifest.projects[0], tools, jobs, deps };
}

test("Codex can do the browser job too, after the owner says yes once, and takes over when Claude cannot reach Chrome", async t => {
  const codex = findHarness("codex").browser;
  assert.equal(codex.guarded, false, "its steps cannot be checked one by one, and the registry says so");
  assert.deepEqual(codex.args(), ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "shell_tool", "-"]);
  const order = browserWorkOrder("bakerysite.co", codex);
  assert.match(order, /Use only the chrome backend of your browser tool/);
  assert.match(order, /no purchase, renewal or add-on/);
  assert.equal(/ToolSearch/.test(order), false);

  // Claude cannot reach Chrome. Codex is not used until the owner has been asked.
  const nameservers = { "bakerysite.co": OTHER };
  const { notices, manifest, project, tools, jobs, deps } = domainSetup(t, nameservers);
  deps.browserAgents = () => [claudeAgent, codexAgent];
  deps.browserRun = async ({ agent, name }) => {
    jobs.push(agent.id);
    assert.equal(name, "bakerysite.co");
    if (agent.id === "codex") nameservers["bakerysite.co"] = VERCEL;
    return { code: 0, stdout: `AIOS-RESULT: {"status":"${agent.id === "claude" ? "no_browser" : "done"}"}` };
  };
  const first = await domainStep({ then: bought, value: "bought", notices, manifest, deps });
  assert.equal(first.reason, "ask_agent");
  assert.deepEqual(jobs, ["claude"]);
  const ask = notices.listOpen().find(n => n.settingKey === "settings.browser.codex");
  assert.match(ask.text, /Claude Code could not reach your Chrome\. Codex can point bakerysite\.co at bakery-site in your Chrome\./);
  assert.match(ask.text, /cannot check Codex's browser steps one by one/);
  assert.deepEqual(ask.choices.map(c => c.value), ["yes", "no"]);
  assert.deepEqual(ask.then.skip, ["claude"], "who already failed is remembered on the question");
  assert.deepEqual(tools, []);

  // The owner's yes is remembered, the job runs again, and the registry decides.
  manifest.settings.browser = { codex: "yes" };
  const again = await domainStep({ then: ask.then, value: "yes", notices, manifest, deps });
  assert.deepEqual(again, { ok: true, name: "bakerysite.co" });
  assert.deepEqual(jobs, ["claude", "codex"], "Claude is not sent to try again first");
  assert.deepEqual(project.domain, { name: "bakerysite.co", state: "pointed" });

  // A no is a no: Codex is never run, and the owner gets the one card.
  const refused = domainSetup(t, { "bakerysite.co": OTHER }, { browser: { codex: "no" } });
  refused.deps.browserAgents = () => [claudeAgent, codexAgent];
  refused.deps.browserRun = async ({ agent }) => { refused.jobs.push(agent.id); return { code: 0, stdout: 'AIOS-RESULT: {"status":"no_browser"}' }; };
  await domainStep({ then: bought, value: "bought", notices: refused.notices, manifest: refused.manifest, deps: refused.deps });
  assert.deepEqual(refused.jobs, ["claude"]);
  const card = refused.notices.listOpen().find(n => n.form === "namecheap");
  assert.match(card.text, /^Claude Code could not reach your Chrome .* It needs Chrome open with the Claude extension\. Then choose Try again\./);
});

test("the registry is asked whatever the agent said, and a by-hand Done is checked before it is believed", async t => {
  // The agent changed the record but reported it could not: the record wins.
  const wrong = domainSetup(t, { "bakerysite.co": VERCEL });
  wrong.deps.browserAgents = () => [claudeAgent];
  wrong.deps.browserRun = async () => ({ code: 0, stdout: 'AIOS-RESULT: {"status":"not_signed_in"}' });
  assert.deepEqual(await domainStep({ then: bought, value: "bought", notices: wrong.notices, manifest: wrong.manifest, deps: wrong.deps }), { ok: true, name: "bakerysite.co" });

  // By hand, pressed Done too early: not marked, asked to check again, and marked once the record shows it.
  const nameservers = { "bakerysite.co": OTHER };
  const hand = domainSetup(t, nameservers);
  const done = { type: "domain", step: "manual-done", project: "bakery-site", row: "P1", name: "bakerysite.co" };
  const early = await domainStep({ then: done, value: "done", notices: hand.notices, manifest: hand.manifest, deps: hand.deps });
  assert.deepEqual(early, { ok: false, reason: "unverified" });
  assert.equal(hand.project.domain, undefined);
  const check = hand.notices.listOpen().find(n => n.then?.step === "manual-done");
  assert.match(check.text, /does not show ns1\.vercel-dns\.com and ns2\.vercel-dns\.com yet/);
  assert.deepEqual(check.choices, [{ label: "Check again", value: "done" }]);
  nameservers["bakerysite.co"] = VERCEL;
  assert.deepEqual(await domainStep({ then: check.then, value: "done", notices: hand.notices, manifest: hand.manifest, deps: hand.deps }), { ok: true, name: "bakerysite.co", verified: true });

  // A registry that cannot be reached is not a yes: nothing is marked, and the owner can check again.
  const blind = domainSetup(t, {});
  blind.deps.fetchFn = async () => { throw new Error("offline"); };
  assert.deepEqual(await domainStep({ then: done, value: "done", notices: blind.notices, manifest: blind.manifest, deps: blind.deps }), { ok: false, reason: "unverified" });
  assert.equal(blind.project.domain, undefined);
  assert.match(blind.notices.listOpen().at(-1).text, /I could not reach the public record for bakerysite\.co just now, so I cannot confirm it yet\. Nothing is marked done\./);

  // Only a name ending that has no public record anywhere is taken on the owner's word, and that is said.
  const none = domainSetup(t, {});
  const odd = { ...done, name: "bakery.xyz" };
  const taken = await domainStep({ then: odd, value: "done", notices: none.notices, manifest: none.manifest, deps: none.deps });
  assert.deepEqual(taken, { ok: true, name: "bakery.xyz", verified: false });
  assert.match(none.notices.listOpen().at(-1).text, /Names ending in \.xyz have no public record I can check, so this is on your word/);
});

test("a test that forgets its stand-ins reaches nothing real: no network, no keyring, no GitHub, no Vercel, no installer", async t => {
  const { notices, manifest } = domainSetup(t, {});
  // No deps at all. Before this guard, this would have read the keyring and called the real registry and Vercel.
  const result = await domainStep({ then: { type: "domain", step: "offer", project: "bakery-site", row: "P1" }, value: "find", notices, manifest });
  assert.deepEqual(result, { ok: true, found: [] });
  assert.deepEqual(await defaultRun("gh", ["repo", "create", "x", "--private"]), { code: 125, refused: true, stdout: "", stderr: "refused during a test run" });
  assert.equal((await defaultRun("vercel", ["deploy", "--prod", "--yes"])).refused, true);
  assert.equal((await defaultRun("git", ["push", "-u", "origin", "HEAD"])).refused, true);
  assert.equal((await installTool("opencode", { locate: () => "/bin/npm" })).ok, false, "the real installer does not run from a test");
});

test("nothing is pushed to a repository that is not private, or not the one made for the project", async t => {
  const { board, manifest, notices } = setup(t, { ship: { github: "yes" } });
  const folder = path.join(manifest.projectsHome, "bakery-site");
  fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
  manifest.projects = [{ name: "bakery-site", path: folder, repo: "owner/bakery-site", createdByOs: true, online: "no" }];
  const row = board.addTask({ task: "Build the bakery site", to: "claude", from: "You", meta: { kind: "build", project: "bakery-site" } });
  let origin = { nameWithOwner: "owner/bakery-site", visibility: "PUBLIC" };
  const lines = [];
  const run = async (tool, args) => {
    const line = `${tool} ${args.join(" ")}`;
    lines.push(line);
    if (line === "gh repo view --json nameWithOwner,visibility") return { code: 0, stdout: JSON.stringify(origin), stderr: "" };
    if (line === "gh repo view --json url --jq .url") return { code: 0, stdout: "https://github.com/owner/bakery-site\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const pushed = () => lines.some(line => line.startsWith("git push"));

  const open = await shipVersion({ board, root: row.ID, manifest, notices, run });
  assert.deepEqual([open.failed, open.reason], ["github", "not_private"]);
  assert.equal(pushed(), false);
  assert.match(notices.listOpen().at(-1).text, /I did not push bakery-site: its GitHub repository \(owner\/bakery-site\) is not private/);

  origin = { nameWithOwner: "someone/else", visibility: "PRIVATE" };
  const moved = await shipVersion({ board, root: row.ID, manifest, notices, run });
  assert.equal(moved.reason, "other_repo");
  assert.equal(pushed(), false);

  origin = { nameWithOwner: "Owner/Bakery-Site", visibility: "PRIVATE" };
  const fine = await shipVersion({ board, root: row.ID, manifest, notices, run });
  assert.equal(fine.repoUrl, "https://github.com/owner/bakery-site");
  assert.equal(pushed(), true);
});

test("stopping a program reaches everything it started, on every kind of computer", () => {
  const signals = [];
  let killed = 0;
  stopProcessTree({ pid: 4321, kill: () => { killed++; } }, { platform: "linux", killGroup: (pid, signal) => signals.push([pid, signal]) });
  assert.deepEqual(signals, [[-4321, "SIGTERM"]], "the whole group, not just the one process");
  assert.equal(killed, 1);
  stopProcessTree({ pid: 9, kill: () => { killed++; } }, { platform: "darwin", killGroup: () => { throw new Error("not a group head"); } });
  assert.equal(killed, 2, "a failed group signal still stops the process itself");
  assert.deepEqual(ownGroup("linux"), { detached: true });
  assert.deepEqual(ownGroup("win32"), {});
});

test("the organizer keeps asking until the picture is clear, and stops when told to go ahead", async t => {
  const { board, manifest, go } = setup(t);
  const row = queueOrganizerRequest({ board, manifest, task: "Build me a booking site for my salon with online payments" });
  const questions = ["Who books: walk-ins, regulars, or both?", "Which services, and how long does each take?", "Should it take a deposit?", "What should it look like?"];
  let asked = 0;
  let builds = 0;
  const runner = async ({ mode, prompt }) => {
    if (mode !== "read") { builds++; return { status: "Done", answer: "Built." }; }
    assert.match(prompt, /Keep asking, over as many messages as it takes, until the picture is clear/);
    assert.match(prompt, /Stop asking as soon as the picture is clear, or the owner tells you to go ahead/);
    if (asked < questions.length) return { status: "Waiting on User", result: "clarify", answer: "One more thing.", question: questions[asked++] };
    return { status: "Waiting on User", result: "delegate", answer: "Sending it to a builder.", delegation: { role: "builder", work: "Build the salon booking site as agreed", newProject: "salon-booking" } };
  };
  const shipRun = gitInit;
  for (const question of questions) {
    await go(row.ID, runner, { shipRun });
    const meta = board.getMeta(row.ID);
    assert.equal(meta.answer, question);
    assert.equal(builds, 0, "nothing is built while questions are open");
    replyToOrganizer({ taskId: row.ID, text: "Answer to: " + question, turn: meta.conversation.length, board, manifest });
  }
  await go(row.ID, runner, { shipRun });
  assert.equal(asked, 4, "four rounds of questions, not one");
  assert.equal(builds, 1);

  // Near the limit the organizer is told to stop asking and decide.
  const long = Array.from({ length: 38 }, (_, index) => ({ role: index % 2 ? "user" : "muse", text: "x" }));
  const prompt = buildWorkOrderPrompt({ ID: "P9", Task: "Build it", To: "claude" }, manifest, { musePhase: "organize", intent: "coding", conversation: long, projects: [] });
  assert.match(prompt, /You have asked enough\. Do not ask another question\. Delegate now/);
  assert.equal(/You have asked enough/.test(buildWorkOrderPrompt({ ID: "P9", Task: "Build it", To: "claude" }, manifest, { musePhase: "organize", intent: "coding", conversation: long.slice(0, 6), projects: [] })), false);
});

test("a voice dump with several new things gives each its own folder", async t => {
  const { board, manifest, go } = setup(t);
  const row = queueOrganizerRequest({ board, manifest, task: "Okay so first build a landing page for my lawn care business, and then also make a recipe app for my mom" });
  const shipRun = gitInit;
  await go(row.ID, async ({ mode }) => (mode === "read"
    ? { status: "Waiting on User", result: "tasks", answer: "Two new things.", split: [
      { role: "builder", work: "Build a landing page for the lawn care business", newProject: "lawn-care-site" },
      { role: "builder", work: "Make a recipe app for mom", newProject: "recipe-app" },
    ] }
    : { status: "Done", answer: "Built." }), { shipRun });
  const made = board.getMeta(row.ID).split.map(id => board.getMeta(id).project);
  assert.deepEqual(made, ["lawn-care-site", "recipe-app"]);
  assert.deepEqual(manifest.projects.map(project => [project.name, project.createdByOs]), [["lawn-care-site", true], ["recipe-app", true]]);
  for (const name of made) assert.ok(fs.existsSync(path.join(manifest.projectsHome, name)));
});

test("asking for a web address in the chat starts the same domain step, and never treats it as a purchase", async t => {
  for (const said of ["give the bakery site its own address", "get a domain for my shop", "Can you find a web address for bakery-site?", "buy a domain for the bakery"]) {
    assert.equal(asksForDomain(said), true, said);
    assert.equal(classifyOrganizerRequest(said), "domain", said);
  }
  for (const said of ["build me a site about domain names", "fix the domain validation bug in the code", "give me a summary"]) assert.equal(asksForDomain(said), false, said);

  const { board, manifest, notices, go } = setup(t);
  const never = async () => assert.fail("no agent is needed to find a name");
  const nothing = queueOrganizerRequest({ board, manifest, task: "give my site its own address" });
  await go(nothing.ID, never);
  assert.match(board.getMeta(nothing.ID).answer, /once I have built it and put it online/);

  manifest.projects = [
    { name: "bakery-site", path: path.join(manifest.projectsHome, "bakery-site"), createdByOs: true, online: "yes" },
    { name: "recipe-app", path: path.join(manifest.projectsHome, "recipe-app"), createdByOs: true, online: "no" },
    { name: "client-work", path: path.join(manifest.projectsHome, "client-work"), online: "yes" },
  ];
  const steps = [];
  const domain = async step => { steps.push(step); return { ok: true, found: [{ name: "bakerysite.co", price: null }] }; };
  const row = queueOrganizerRequest({ board, manifest, task: "give the bakery-site its own address" });
  await go(row.ID, never, { domain });
  assert.deepEqual(steps[0].then, { type: "domain", step: "offer", project: "bakery-site", row: row.ID });
  assert.match(board.getMeta(row.ID).answer, /I found a free address for bakery-site\. .* I never buy anything\./);

  const offline = queueOrganizerRequest({ board, manifest, task: "get a domain for recipe-app" });
  await go(offline.ID, never, { domain });
  assert.match(board.getMeta(offline.ID).answer, /recipe-app is not online yet/);
  assert.equal(steps.length, 1);

  // A project this software did not create is never offered, even when it is named.
  const theirs = queueOrganizerRequest({ board, manifest, task: "get a domain for client-work" });
  await go(theirs.ID, never, { domain });
  assert.equal(steps.length, 2, "it falls to the one project that is online, never to client-work");
  assert.equal(steps[1].then.project, "bakery-site");
});

test("a missing or outdated tool is added from the app on the owner's press, and the waiting work carries on", async t => {
  assert.deepEqual(installCommand(installable("opencode"), { platform: "linux", locate: () => "/usr/bin/npm" }), { file: "/usr/bin/npm", args: ["install", "-g", "opencode-ai@latest"] });
  assert.deepEqual(installCommand(installable("github"), { platform: "win32", locate: () => "C:\\winget.exe" }).args.slice(0, 3), ["install", "--id", "GitHub.cli"]);
  assert.equal(installCommand(installable("vercel"), { platform: "linux", locate: () => null }), null);
  assert.equal(installable("rm -rf /"), null, "only what is listed can be installed");
  assert.deepEqual(await installTool("nonsense"), { ok: false, label: "nonsense", reason: "unknown" });
  let refreshed = 0;
  assert.deepEqual(await installTool("opencode", { locate: () => "/bin/npm", run: async () => ({ code: 0 }), afterInstall: () => { refreshed++; } }), { ok: true, label: "OpenCode (free)" });
  assert.equal(refreshed, 1);
  assert.equal((await installTool("opencode", { locate: () => "/bin/npm", run: async () => ({ code: 1 }) })).reason, "failed");
  assert.equal((await installTool("opencode", { locate: () => null })).reason, "no_installer");

  // Nobody signed in, and the free agent is too old to work: one press updates it and the task starts itself.
  const { board, manifest, notices, go } = setup(t);
  const row = board.addTask({ task: "Tidy the notes folder", to: "claude" });
  const detect = () => [
    { id: "claude", label: "Claude Code", state: "installed", workerPath: "/bin/claude", installed: true, signedIn: false, headless: true },
    { id: "opencode", label: "OpenCode (free)", state: "outdated", workerPath: "/bin/opencode", installed: true, signedIn: false, headless: false, free: true, canInstall: true },
  ];
  const waiting = await go(row.ID, async () => assert.fail("no agent is ready"), { availability: { claude: false, opencode: false }, detect });
  assert.equal(waiting.reason, "NO_AGENT");
  const card = notices.listOpen().find(n => n.then?.type === "signin");
  assert.deepEqual(card.choices, [{ label: "Sign in to Claude Code", value: "signin:claude" }, { label: "Update OpenCode (free)", value: "install:opencode" }]);
  assert.match(card.text, /Or update OpenCode \(free\), which needs no account/);

  const installs = [];
  const answered = answerNotice({ noticeId: card.id, value: "install:opencode", notices, board, manifest, install: async id => { installs.push(id); return { ok: true, label: "OpenCode (free)" }; } });
  await answered.installing;
  assert.deepEqual(installs, ["opencode"]);
  assert.equal(board.findTask(row.ID).Status, "Open", "the task that was waiting is put back in line");
  assert.ok(notices.listOpen().some(n => n.text === "OpenCode (free) is on this computer now."));

  // A sign-in tool that is missing is offered the same way, then the sign-in runs by itself.
  const ship = queueOrganizerRequest({ board, manifest, task: "ship it" });
  const blocked = notices.raise({ row: ship.ID, kind: "blocked", text: "Connect Vercel", choices: [{ label: "Connect Vercel", value: "connect:vercel" }], then: { type: "connect", row: ship.ID } });
  const connects = [];
  const connect = async service => { connects.push(service); return connects.length === 1 ? { ok: false, reason: "missing", get: "https://vercel.com/docs/cli" } : { ok: true }; };
  let shipped = 0;
  const options = { notices, board, manifest, connect, ship: async () => { shipped++; }, install: async id => { installs.push(id); return { ok: true, label: "Vercel's sign-in tool" }; } };
  await answerNotice({ noticeId: blocked.id, value: "connect:vercel", ...options }).connecting;
  const add = notices.listOpen().find(n => n.choices.some(c => c.value === "install:vercel"));
  assert.match(add.text, /Vercel's sign-in tool is not on this computer yet\. It is free\. Add it and this carries on by itself\./);
  await answerNotice({ noticeId: add.id, value: "install:vercel", ...options }).installing;
  assert.deepEqual(installs, ["opencode", "vercel"]);
  assert.deepEqual(connects, ["vercel", "vercel"]);
  assert.equal(shipped, 1, "after the tool is added and the sign-in approved, the waiting version ships");
});

test("a task that needs GitHub starts GitHub's real sign-in instead of only noting the choice", async t => {
  const { board, manifest, notices } = setup(t);
  const row = board.addTask({ task: "Open a pull request on GitHub for the fix", to: "claude", from: "You" });
  board.updateByColumnName({ taskId: row.ID, agent: "Muse", columns: { Status: "Waiting on User" } });
  const ask = notices.raise({ row: row.ID, kind: "question", text: "This task needs GitHub. Connect it?", choices: [{ label: "Connect", value: "connect" }, { label: "Skip", value: "skip" }], settingKey: "services.github", then: { type: "service", service: "github", row: row.ID } });
  const connects = [];
  const result = answerNotice({
    noticeId: ask.id, value: "connect", notices, board, manifest,
    shipRun: async (tool, args) => ({ code: tool === "gh" && args.join(" ") === "auth status" ? 1 : 0, stdout: "", stderr: "" }),
    connect: async (service, { onPrompt }) => { connects.push(service); onPrompt({ link: "https://github.com/login/device", code: "ABCD-1234" }); return { ok: true }; },
  });
  assert.equal(board.findTask(row.ID).Status, "Waiting on User", "the task waits for the sign-in instead of running without it");
  await result.connecting;
  assert.deepEqual(connects, ["github"]);
  assert.ok(notices.listAll().some(n => /enter the code ABCD-1234/.test(n.text)));
  assert.equal(board.findTask(row.ID).Status, "Open");
});

test("a note sent from the phone goes into the next version of the build it names", async t => {
  const { board, manifest, notices } = setup(t);
  const build = board.addTask({ task: "Build the bakery site", to: "claude", from: "You", meta: { kind: "build", builder: "claude" } });
  board.updateByColumnName({ taskId: build.ID, agent: "Muse", columns: { Status: "Done" } });
  board.setMeta(build.ID, { audit: { state: "checking" } });
  const queue = [
    { id: "r1", kind: "request", body: { text: `Note for ${build.ID.toLowerCase()}: make the header blue`, to: null } },
    { id: "r2", kind: "request", body: { text: "Note for P999: this is not a build", to: null } },
  ];
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
  assert.equal(await link.tick(), true);
  assert.deepEqual(board.getMeta(build.ID).ownerNotes, ["make the header blue"]);
  assert.ok(notices.listAll().some(n => n.text === `Your note is saved for the next version of ${build.ID}.`));
  // Words that do not name a finished build are not lost: they become an ordinary request.
  assert.ok(board.listTasks().some(row => row.Task === "Note for P999: this is not a build"));
  // The relay hands the same message over again until it is acknowledged. It is taken once.
  await link.tick();
  assert.deepEqual(board.getMeta(build.ID).ownerNotes, ["make the header blue"]);
  assert.equal(board.listTasks().filter(row => row.Task === "Note for P999: this is not a build").length, 1);

  const page = fs.readFileSync(path.join(__dirname, "..", "phone", "index.html"), "utf8");
  assert.ok(page.includes('"Note for " + n.row + ": " + words'));
  assert.ok(page.includes("Add a note"));
});

test("what a person types or changes in the Sheet comes back to the board", async t => {
  const { board, manifest } = setup(t);
  const cells = [];
  const calls = [];
  const call = async (tool, args) => {
    calls.push(tool);
    if (tool === "get_spreadsheet_metadata") return { sheets: [{ properties: { sheetId: 7, title: "Tasks" } }] };
    if (tool === "get_spreadsheet_range") return { range: "Tasks!A1:J60", majorDimension: "ROWS", values: cells.map(row => [...row]) };
    if (tool === "batch_update_spreadsheet") {
      for (const request of args.requests) request.updateCells.rows.forEach((row, offset) => { cells[request.updateCells.start.rowIndex + offset] = row.values.map(value => value.userEnteredValue.stringValue); });
      return { ok: true };
    }
    throw new Error("unexpected " + tool);
  };
  const state = {};
  let clock = 1000000;
  const queued = [];
  const queue = options => { queued.push([options.task, options.source]); return queueOrganizerRequest(options); };
  const sync = () => syncBoardSheet({ call, boardId: "sheet1", board, state, manifest, queue, addNote: addVersionNote, now: () => clock, readBackMs: 60000 });

  const build = board.addTask({ task: "Build the bakery site", to: "claude", from: "You", meta: { kind: "build", builder: "claude" } });
  board.updateByColumnName({ taskId: build.ID, agent: "Muse", columns: { Status: "Done" } });
  board.setMeta(build.ID, { audit: { state: "checking" } });
  const chore = board.addTask({ task: "Renew the business licence", to: "claude", from: "You" });
  board.updateByColumnName({ taskId: chore.ID, agent: "Muse", columns: { Status: "Waiting on User" } });
  await sync();
  assert.equal(cells.length, 3);

  // A person types a new line, marks a task done, and writes a note on the finished build.
  const col = name => cells[0].indexOf(name);
  cells.push(["", "Call the printer about the menus", "", "", "", "", "", "", "", ""]);
  cells[2][col("Status")] = "done";
  cells[1][col("Latest note")] = "Make the header blue";
  clock += 30000;
  assert.equal((await sync()).changed, false, "the Sheet is read once a minute, not on every pass");
  clock += 31000;
  const back = await sync();
  assert.equal(back.cameBack, 3);
  assert.deepEqual(queued, [["Call the printer about the menus", "sheet"]]);
  assert.equal(board.findTask(chore.ID).Status, "Done");
  assert.deepEqual(board.getMeta(build.ID).ownerNotes, ["Make the header blue"]);

  // The typed line is now a numbered task in its place, and reading again takes nothing twice.
  const typed = board.listTasks().find(row => row.Task === "Call the printer about the menus");
  assert.equal(cells[3][col("ID")], typed.ID);
  assert.equal(board.getMeta(typed.ID).source, "sheet");
  clock += 61000;
  assert.equal((await sync()).cameBack, 0);
  assert.equal(queued.length, 1);

  // The board wins when it moved on since the Sheet was last written, and work in progress is never overridden.
  const busy = board.addTask({ task: "Fix the footer", to: "claude", from: "You" });
  clock += 61000;
  await sync();
  board.claimTask({ taskId: busy.ID, agent: "claude", assignTo: "claude" });
  cells[4][col("Status")] = "Done";
  clock += 61000;
  await sync();
  assert.equal(board.findTask(busy.ID).Status, "In progress");
  assert.equal(cells[4][col("Status")], "In progress", "the Sheet is put back to what is true");
  assert.match(buildWorkOrderPrompt({ ID: typed.ID, Task: typed.Task, To: "claude" }, manifest, { source: "sheet" }), /typed into the owner's Google Sheet, which other people may be able to edit/);
});

test("a new project never takes over a folder that is already there, and nothing is built without a folder", async t => {
  const { board, manifest, go } = setup(t);
  const run = gitInit;
  // The owner already has a folder by that name. It is not adopted, initialised or pinned.
  const theirs = path.join(manifest.projectsHome, "tax-returns");
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, "2025.txt"), "private");
  await assert.rejects(createProject({ manifest, name: "Tax Returns", run }), error => error.code === "PROJECT_EXISTS");
  assert.equal(fs.existsSync(path.join(theirs, ".git")), false);
  assert.equal(manifest.projects, undefined);
  // A folder that could not be started is not left behind as a project.
  await assert.rejects(createProject({ manifest, name: "broken-start", run: async () => ({ code: 1, stdout: "", stderr: "" }) }), error => error.code === "PROJECT_NOT_STARTED");
  assert.equal(fs.existsSync(path.join(manifest.projectsHome, "broken-start")), false);
  // Git failed but left a half-made .git folder behind: still not a project, and the folder is cleaned up.
  const half = async (tool, args, options) => { fs.mkdirSync(path.join(options.cwd, ".git")); return { code: 128, stdout: "", stderr: "fatal" }; };
  await assert.rejects(createProject({ manifest, name: "half-made", run: half }), error => error.code === "PROJECT_NOT_STARTED" && !error.gitMissing);
  assert.equal(fs.existsSync(path.join(manifest.projectsHome, "half-made")), false);
  await assert.rejects(createProject({ manifest, name: "no-git", run: async () => ({ code: 127, missing: true, stdout: "", stderr: "" }) }), error => error.gitMissing === true);
  // Something else puts a file in the new folder while git is failing: that file is never deleted.
  const raced = async (tool, args, options) => { fs.writeFileSync(path.join(options.cwd, "theirs.txt"), "keep me"); fs.mkdirSync(path.join(options.cwd, ".git")); return { code: 128, stdout: "", stderr: "" }; };
  await assert.rejects(createProject({ manifest, name: "raced", run: raced }), error => error.code === "PROJECT_NOT_STARTED");
  assert.equal(fs.readFileSync(path.join(manifest.projectsHome, "raced", "theirs.txt"), "utf8"), "keep me");
  assert.equal(fs.existsSync(path.join(manifest.projectsHome, "raced", ".git")), false, "only git's own leftovers are removed");
  // One this software made is reused when asked for again by the same name.
  const made = await createProject({ manifest, name: "bakery-site", run });
  assert.equal(await createProject({ manifest, name: "Bakery Site", run }), made);

  // The organizer names a folder that is taken: it asks, and no builder runs anywhere.
  let builds = 0;
  const row = queueOrganizerRequest({ board, manifest, task: "Build a tracker for my tax returns with a page per year and a summary of what is owed" });
  await go(row.ID, async ({ mode }) => {
    if (mode !== "read") { builds++; return { status: "Done", answer: "Built." }; }
    return { status: "Waiting on User", result: "delegate", answer: "Sending it to a builder.", delegation: { role: "builder", work: "Build the tax tracker", newProject: "tax-returns" } };
  }, { shipRun: run });
  assert.equal(builds, 0);
  const meta = board.getMeta(row.ID);
  assert.equal(meta.awaitingReply, true);
  assert.match(meta.answer, /I could not make a folder named tax-returns for this, because something with that name is already on this computer/);

  // In a voice dump, the one whose folder could not be made goes back to the organizer; the other is built.
  const dump = queueOrganizerRequest({ board, manifest, task: "First build a recipe app for my mom and then also make a tax returns tracker" });
  await go(dump.ID, async ({ mode }) => (mode === "read"
    ? { status: "Waiting on User", result: "tasks", answer: "Two things.", split: [
      { role: "builder", work: "Make a recipe app for mom", newProject: "recipe-app" },
      { role: "builder", work: "Make a tax returns tracker", newProject: "tax-returns" },
    ] }
    : { status: "Done", answer: "Built." }), { shipRun: run });
  const [recipe, tax] = board.getMeta(dump.ID).split.map(id => board.getMeta(id));
  assert.deepEqual([recipe.project, recipe.musePhase], ["recipe-app", "work"]);
  assert.deepEqual([tax.project ?? null, tax.musePhase], [null, "organize"], "no folder means it is the organizer's to sort out, not a builder's");
});

test("a remote this software has no record of making is never pushed to, even a private one", async t => {
  const { board, manifest, notices } = setup(t, { ship: { github: "yes" } });
  const folder = path.join(manifest.projectsHome, "bakery-site");
  fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
  manifest.projects = [{ name: "bakery-site", path: folder, repo: null, createdByOs: true, online: "no" }];
  const row = board.addTask({ task: "Build the bakery site", to: "claude", from: "You", meta: { kind: "build", project: "bakery-site" } });
  const lines = [];
  let hasRemote = true;
  const run = async (tool, args) => {
    const line = `${tool} ${args.join(" ")}`;
    lines.push(line);
    if (line === "git remote get-url origin") return { code: hasRemote ? 0 : 2, stdout: "", stderr: "" };
    if (line.startsWith("gh repo create")) hasRemote = true;
    if (line === "gh repo view --json nameWithOwner,visibility") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "owner/bakery-site", visibility: "PRIVATE" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const refused = await shipVersion({ board, root: row.ID, manifest, notices, run });
  assert.deepEqual([refused.failed, refused.reason], ["github", "other_repo"]);
  assert.equal(lines.some(line => line.startsWith("git push")), false);
  assert.match(notices.listOpen().at(-1).text, /points at a GitHub repository \(owner\/bakery-site\) that is not the one I made for it/);

  // Made by this software: its name is recorded from GitHub's own answer, so the next push can be checked against it.
  hasRemote = false;
  lines.length = 0;
  const first = await shipVersion({ board, root: row.ID, manifest, notices, run });
  assert.equal(first.repoUrl, "https://github.com/owner/bakery-site");
  assert.equal(manifest.projects[0].repo, "owner/bakery-site");
  assert.ok(lines.some(line => line.startsWith("gh repo create bakery-site --private")));
});

test("a note that orders a send or a spend, from the Sheet or the phone, goes to the organizer's gates and not to a builder", async t => {
  const { board, manifest, notices } = setup(t);
  const build = board.addTask({ task: "Build the bakery site", to: "claude", from: "You", meta: { kind: "build", builder: "claude" } });
  board.updateByColumnName({ taskId: build.ID, agent: "Muse", columns: { Status: "Done" } });
  board.setMeta(build.ID, { audit: { state: "checking" } });

  // The Sheet. The write back fails once, so the same edits are read a second time.
  const cells = [];
  let failWrites = 1;
  const call = async (tool, args) => {
    if (tool === "get_spreadsheet_metadata") return { sheets: [{ properties: { sheetId: 7, title: "Tasks" } }] };
    if (tool === "get_spreadsheet_range") return { values: cells.map(row => [...row]) };
    if (failWrites-- > 0 && cells.length) throw new Error("Google is not answering");
    for (const request of args.requests) request.updateCells.rows.forEach((row, offset) => { cells[request.updateCells.start.rowIndex + offset] = row.values.map(value => value.userEnteredValue.stringValue); });
    return { ok: true };
  };
  const state = {};
  let clock = 5000000;
  failWrites = 0;
  const sync = () => syncBoardSheet({ call, boardId: "sheet1", board, state, manifest, queue: queueOrganizerRequest, addNote: addVersionNote, now: () => clock, readBackMs: 60000 });
  await sync();
  const col = name => cells[0].indexOf(name);
  cells[1][col("Latest note")] = "Email the customer list to sam@example.com";
  cells.push(["", "Order new flour sacks", "", "", "", "", "", "", "", ""]);
  failWrites = 1;
  clock += 61000;
  await assert.rejects(sync(), /Google is not answering/);
  clock += 61000;
  await sync();
  assert.deepEqual(board.getMeta(build.ID).ownerNotes || [], [], "an order to send is never handed to a builder as a note");
  const fromSheet = board.listTasks().filter(row => board.getMeta(row.ID).source === "sheet");
  assert.deepEqual(fromSheet.map(row => row.Task).sort(), ["Email the customer list to sam@example.com", "Order new flour sacks"], "each is taken once, though it was read twice");
  assert.equal(board.getMeta(fromSheet.find(row => /Email/.test(row.Task)).ID).intent, "external_action", "it will be held for the owner's yes");

  // The phone: the same rule, and a note is recorded before it is applied so it can never be taken twice.
  const queue = [
    { id: "r1", kind: "request", body: { text: `Note for ${build.ID}: then publish it to the app store`, to: null } },
    { id: "r2", kind: "request", body: { text: `Note for ${build.ID}: make the header blue`, to: null } },
  ];
  let failNote = true;
  const acked = [];
  const link = createCloudLink({
    relayUrl: "https://relay.example", homeToken: "home", board, notices, manifest, makeSheetTasks: () => ({ configured: false }),
    addNote: options => { if (failNote) { failNote = false; throw new Error("disk full"); } return addVersionNote(options); },
    async fetchFn(url, { body } = {}) {
      const route = new URL(url).pathname.split("/").at(-1);
      if (route === "ack") acked.push(...JSON.parse(body).ids);
      return new Response(JSON.stringify(route === "pull" ? { items: queue, push: [] } : {}));
    },
  });
  await link.tick();
  await link.tick();
  const held = board.listTasks().filter(row => row.Task === "then publish it to the app store");
  assert.equal(held.length, 1);
  assert.equal(board.getMeta(held[0].ID).intent, "external_action");
  assert.deepEqual(board.getMeta(build.ID).ownerNotes, ["make the header blue"], "the note that failed to save is saved on the next pass, once");
  assert.equal(board.listTasks().some(row => /make the header blue/.test(row.Task)), false, "and never turned into a second, ordinary request");
  assert.deepEqual(acked, ["r1", "r1", "r2"], "the one that failed was not acknowledged until it was saved");
});

test("building work with nowhere to build is asked about, and a folder that cannot be made says why", async t => {
  const { board, manifest, go } = setup(t);
  const projects = [{ name: "bakery-site", path: path.join(manifest.projectsHome, "bakery-site"), repo: null }, { name: "salon-booking", path: path.join(manifest.projectsHome, "salon-booking"), repo: null }];
  let builds = 0;
  const builder = work => async ({ mode }) => {
    if (mode !== "read") { builds++; return { status: "Done", answer: "Built." }; }
    return { status: "Waiting on User", result: "delegate", answer: "Sending it.", delegation: { role: "builder", work } };
  };
  // No project named, none in the owner's words: the organizer asks which one, naming them.
  const row = queueOrganizerRequest({ board, manifest, task: "Fix the broken checkout button so the total updates when the quantity changes" });
  await go(row.ID, builder("Fix the checkout total"), { projects, shipRun: gitInit });
  assert.equal(builds, 0, "nothing is built in this app's own folder");
  assert.equal(board.getMeta(row.ID).answer, "Which project is this for: bakery-site, salon-booking? Or is it something new?");
  assert.equal(board.getMeta(row.ID).awaitingReply, true);
  // The owner's answer names it, and the work goes there.
  replyToOrganizer({ taskId: row.ID, text: "The bakery-site one", turn: board.getMeta(row.ID).conversation.length, board, manifest });
  const where = [];
  await go(row.ID, async options => { if (options.mode !== "read") where.push(options.cwd); return builder("Fix the checkout total")(options); }, { projects, shipRun: gitInit });
  assert.deepEqual(where, [projects[0].path]);

  // In a voice dump, a building job with no project goes back to the organizer, not to a builder.
  const dump = queueOrganizerRequest({ board, manifest, task: "First fix the checkout button and then also research what other bakeries charge for delivery" });
  await go(dump.ID, async ({ mode }) => (mode === "read"
    ? { status: "Waiting on User", result: "tasks", answer: "Two things.", split: [{ role: "builder", work: "Fix the checkout button" }, { role: "researcher", work: "Research bakery delivery prices" }] }
    : assert.fail("nothing runs yet")), { projects, shipRun: gitInit });
  const [fix, look] = board.getMeta(dump.ID).split.map(id => board.getMeta(id));
  assert.equal(fix.musePhase, "organize");
  assert.equal(look.kind, "research", "research needs no folder");

  // Git is missing: the owner is told that, with a way to try again, not asked for another name.
  const fresh = queueOrganizerRequest({ board, manifest, task: "Build a booking page for my dog grooming business so regular customers can pick a time, get a reminder the day before, and see their past visits" });
  await go(fresh.ID, async ({ mode }) => (mode === "read"
    ? { status: "Waiting on User", result: "delegate", answer: "New.", delegation: { role: "builder", work: "Build it", newProject: "dog-grooming" } }
    : assert.fail("no folder, no build")), { projects, shipRun: async () => ({ code: 127, missing: true, stdout: "", stderr: "" }) });
  assert.match(board.getMeta(fresh.ID).answer, /because Git is not on this computer\. Install Git from git-scm\.com, then choose Try again\./);
  assert.notEqual(board.getMeta(fresh.ID).awaitingReply, true);
});

test("a line typed again in the Sheet after it was written over is taken again", async t => {
  const { board, manifest } = setup(t);
  const cells = [];
  const call = async (tool, args) => {
    if (tool === "get_spreadsheet_metadata") return { sheets: [{ properties: { sheetId: 7, title: "Tasks" } }] };
    if (tool === "get_spreadsheet_range") return { values: cells.map(row => [...row]) };
    for (const request of args.requests) request.updateCells.rows.forEach((row, offset) => { cells[request.updateCells.start.rowIndex + offset] = row.values.map(value => value.userEnteredValue.stringValue); });
    return { ok: true };
  };
  const state = {};
  let clock = 9000000;
  const sync = () => syncBoardSheet({ call, boardId: "sheet1", board, state, manifest, queue: queueOrganizerRequest, addNote: addVersionNote, now: () => (clock += 61000), readBackMs: 60000 });
  const build = board.addTask({ task: "Build the bakery site", to: "claude", from: "You", meta: { kind: "build", builder: "claude" } });
  board.updateByColumnName({ taskId: build.ID, agent: "Muse", columns: { Status: "Done" } });
  board.setMeta(build.ID, { audit: { state: "checking" } });
  await sync();
  const col = name => cells[0].indexOf(name);

  cells.push(["", "Call the printer", "", "", "", "", "", "", "", ""]);
  cells[1][col("Latest note")] = "Make the header blue";
  await sync();
  // The Sheet was rewritten: the typed line is now a numbered task, and the note cell shows the board's own note.
  assert.equal(board.listTasks().filter(row => row.Task === "Call the printer").length, 1);
  // The same words, typed again on the next empty line and over the note: both are new, and both are taken.
  cells.push(["", "Call the printer", "", "", "", "", "", "", "", ""]);
  cells[1][col("Latest note")] = "Make the header blue";
  await sync();
  assert.equal(board.listTasks().filter(row => row.Task === "Call the printer").length, 2);
  assert.deepEqual(board.getMeta(build.ID).ownerNotes, ["Make the header blue", "Make the header blue"]);
  // Nothing is left pending once the Sheet has been written.
  assert.equal(board.listTasks().some(row => (board.getMeta(row.ID).sheetNotesPending || []).length || (board.getMeta(row.ID).sheetReceipt && board.getMeta(row.ID).sheetShown !== true)), false);
});
