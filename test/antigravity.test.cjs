"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { findHarness } = require("../lib/harness-registry.cjs");
const { routeTask } = require("../lib/roles.cjs");
const { defaultCliRunner } = require("../lib/os-runtime.cjs");
const { antigravityDecision, ensureAntigravityGuard } = require("../lib/no-purchase.cjs");

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeAgy(seen) {
  return (file, args, options) => {
    Object.assign(seen, { args, env: options?.env || {} });
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = { on() {}, end() {}, write() {} };
    setImmediate(() => { child.stdout.emit("data", "Built the page and ran npm install."); child.emit("close", 0); });
    return child;
  };
}

const detect = () => [{ id: "antigravity", installed: true, signedIn: true, headless: true, workerPath: "C:/agy/agy.exe" }];

test("Antigravity's sign-in is checked by listing its models", () => {
  const { status } = findHarness("antigravity");
  assert.deepEqual(status.args, ["models"]);
  assert.equal(status.parse("Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)", 0), true);
  assert.equal(status.parse("Please sign in to continue: run agy and log in", 1), false);
  assert.equal(status.parse("network error", 1), null);
});

test("the purchase check answers Antigravity's hook: buying denied, the app's own runs approved, unreadable denied", () => {
  const call = command => JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: command } } });
  assert.equal(antigravityDecision(call("echo vercel domains buy example.com"), { AIOS_AGY_WORKER: "1" }).decision, "deny");
  assert.equal(antigravityDecision(call("npm install"), { AIOS_AGY_WORKER: "1" }).decision, "auto_approve");
  assert.equal(antigravityDecision(JSON.stringify({ toolCall: { name: "write_file", args: {} } }), { AIOS_AGY_WORKER: "1" }).decision, "auto_approve");
  // Anything that is not one of the five build tools (a connected service, a browser) is never auto-approved.
  for (const name of ["mcp_stripe_create_charge", "browser_subagent", "send_email", "anything_else"]) {
    assert.equal(antigravityDecision(JSON.stringify({ toolCall: { name, args: {} } }), { AIOS_AGY_WORKER: "1" }).decision, "allow", name);
  }
  // In the owner's own Antigravity sessions, only buying is refused; everything else follows their usual rules.
  assert.equal(antigravityDecision(call("npm install"), {}).decision, "allow");
  assert.equal(antigravityDecision(call("vercel domains buy example.com"), {}).decision, "deny");
  assert.equal(antigravityDecision("not json", { AIOS_AGY_WORKER: "1" }).decision, "deny");
  assert.equal(antigravityDecision(JSON.stringify({ toolCall: { name: "run_command", args: {} } }), {}).decision, "deny");
});

test("the hook is added beside the owner's other hooks, once, and never over a file it cannot read", t => {
  const home = tempDir(t, "aios-agy-home-");
  const file = path.join(home, ".gemini", "config", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ "owners-own": { PreToolUse: [] } }));
  assert.equal(ensureAntigravityGuard({ home, node: "C:/Program Files/nodejs/node.exe", script: "C:/app/lib/no-purchase.cjs" }), true);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["ai-first-os-no-purchase", "owners-own"]);
  assert.equal(saved["ai-first-os-no-purchase"].PreToolUse[0].hooks[0].command, '"C:/Program Files/nodejs/node.exe" "C:/app/lib/no-purchase.cjs" --agy');
  const before = fs.readFileSync(file, "utf8");
  assert.equal(ensureAntigravityGuard({ home, node: "C:/Program Files/nodejs/node.exe", script: "C:/app/lib/no-purchase.cjs" }), true);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  fs.writeFileSync(file, "{ broken");
  assert.equal(ensureAntigravityGuard({ home, node: "C:/node.exe", script: "C:/app/lib/no-purchase.cjs" }), false);
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
  assert.equal(ensureAntigravityGuard({ home: tempDir(t, "aios-agy-home2-"), node: "C:/node.exe & calc", script: "C:/x.cjs" }), false);
});

test("with the hook in place Antigravity codes with commands; without it, edit-only and told so", async t => {
  const dir = tempDir(t, "aios-agy-");
  const order = () => fs.readFileSync(path.join(dir, ".aios", "work-orders", "P1.md"), "utf8");
  const run = (seen, mode = "write") => defaultCliRunner({ agent: "antigravity", prompt: "Build the page.", cwd: dir, task: { ID: "P1", Task: "Build the page" }, mode, detect, spawnFn: fakeAgy(seen) });

  // Under tests, with no home of its own named, the real hooks file is never touched: edit-only.
  const plain = {};
  await run(plain);
  assert.deepEqual(plain.args.slice(plain.args.indexOf("--mode"), plain.args.indexOf("--mode") + 2), ["--mode", "accept-edits"]);
  assert.equal(plain.env.AIOS_AGY_WORKER, undefined);
  assert.match(order(), /^In this run you can read and edit files in the project, but every shell command is refused/);

  const home = tempDir(t, "aios-agy-home3-");
  process.env.AIOS_AGY_HOOK_HOME = home;
  t.after(() => { delete process.env.AIOS_AGY_HOOK_HOME; });
  const guarded = {};
  await run(guarded);
  assert.equal(guarded.args.includes("--mode"), false);
  for (const forbidden of ["--dangerously-skip-permissions", "auto"]) assert.equal(guarded.args.includes(forbidden), false);
  assert.equal(guarded.env.AIOS_AGY_WORKER, "1");
  assert.equal(order(), "Build the page.");
  const hooks = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "hooks.json"), "utf8"));
  assert.match(hooks["ai-first-os-no-purchase"].PreToolUse[0].hooks[0].command, /no-purchase\.cjs" --agy$/);

  // Reading and research stay in plan mode, without the app-run marker.
  const reading = {};
  await run(reading, "read");
  assert.deepEqual(reading.args.slice(2, 4), ["--mode", "plan"]);
  assert.equal(reading.env.AIOS_AGY_WORKER, undefined);

  const manifest = { roles: { builder: "antigravity" }, priorities: { builder: ["antigravity", "opencode"] } };
  assert.equal(routeTask({ assigned: "antigravity", manifest, availability: { antigravity: true, opencode: true }, role: "builder" }).agent, "antigravity");
});
