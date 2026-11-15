"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PURCHASE_PHRASES, isPurchaseCommand, openCodeConfig, claudeSettings } = require("../lib/no-purchase.cjs");
const { findHarness } = require("../lib/harness-registry.cjs");
const { defaultCliRunner } = require("../lib/os-runtime.cjs");

const SCRIPT = path.join(__dirname, "..", "lib", "no-purchase.cjs");

test("a shell command that can buy something is recognised however it is written", () => {
  for (const command of [
    "vercel domains buy bakerysite.co",
    "npx vercel domains buy bakerysite.co",
    'cmd /c "vercel  domains   buy bakerysite.co"',
    "VC DOMAINS TRANSFER-IN bakerysite.co",
    "vercel install neon",
    "vercel i upstash",
    "vercel integration add supabase",
    "curl -X POST https://api.vercel.com/v1/registrar/domains/bakerysite.co/buy -d '{}'",
    "curl 'https://api.namecheap.com/xml.response?Command=namecheap.domains.create&DomainName=bakerysite.co'",
  ]) assert.equal(isPurchaseCommand(command), true, command);

  // Everyday work is untouched: attaching a name the owner already bought, listing, deploying, installing the tool itself.
  for (const command of [
    "vercel domains add bakerysite.co bakery-site",
    "vercel domains ls",
    "vercel deploy --prod",
    "npm install vercel",
    "npm i -D vitest",
    'git commit -m "add a buy button to the shop page"',
    "curl https://api.namecheap.com/xml.response?Command=namecheap.domains.check",
  ]) assert.equal(isPurchaseCommand(command), false, command);
});

test("OpenCode gets the same list as its own deny rules", () => {
  const { permission } = JSON.parse(openCodeConfig());
  const globs = Object.keys(permission.bash);
  assert.deepEqual(globs, PURCHASE_PHRASES.map(p => `*${p}*`));
  assert.ok(Object.values(permission.bash).every(v => v === "deny"));
  // Each rule names something the hook refuses too, so the two readings cannot drift apart.
  for (const phrase of PURCHASE_PHRASES) assert.equal(isPurchaseCommand(`x ${phrase.replace(/\*/g, "v1")} y`), true, phrase);
  assert.equal(findHarness("opencode").run.env.OPENCODE_CONFIG_CONTENT, openCodeConfig());
});

test("the hook refuses a buying command, lets others run, and refuses what it cannot read", () => {
  const hook = input => spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8" });
  const buy = hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "vercel domains buy bakerysite.co" } }));
  assert.equal(buy.status, 2);
  assert.match(buy.stderr, /can spend the owner's money/);
  assert.equal(hook(JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "npm test" } })).status, 0);
  assert.equal(hook("not json").status, 2);
  assert.equal(hook(JSON.stringify({ tool_name: "Bash", tool_input: {} })).status, 2);
});

test("the hook's command line is built only from plain paths", () => {
  const settings = claudeSettings({ node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\app\\lib\\no-purchase.cjs" });
  const [entry] = settings.hooks.PreToolUse;
  assert.equal(entry.matcher, "Bash|PowerShell");
  assert.equal(entry.hooks[0].command, '"C:\\Program Files\\nodejs\\node.exe" "C:\\app\\lib\\no-purchase.cjs"');
  assert.throws(() => claudeSettings({ node: 'C:\\x" & calc & "', script: SCRIPT }), { code: "UNSAFE_COMMAND_LINE" });
});

test("Claude Code gets the purchase check on every run, and Codex works without internet", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-no-purchase-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let settingsFile = null;
  let settings = null;
  const spawnFn = (file, args) => {
    settingsFile = args[args.indexOf("--settings") + 1];
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.stdin = Object.assign(new EventEmitter(), { end() {
      setImmediate(() => {
        child.stdout.emit("data", JSON.stringify({ type: "result", result: "Done." }) + "\n");
        child.emit("close", 0);
      });
    } });
    child.kill = () => {};
    return child;
  };
  await defaultCliRunner({
    agent: "claude", prompt: "Add a page", cwd: dir, task: { ID: "P1" }, mode: "write", spawnFn,
    detect: () => [{ id: "claude", workerPath: process.platform === "win32" ? "C:\\bin\\claude.exe" : "/bin/claude" }],
  });
  assert.ok(settingsFile, "the run named a settings file");
  // A writing run carries both checks: the purchase check on commands, and the block on connected services.
  assert.deepEqual(settings, claudeSettings({ blockConnectors: true }));
  assert.equal(fs.existsSync(settingsFile), false, "the file is gone once the run ends");

  const codex = findHarness("codex").run.args({ mode: "write" });
  assert.equal(codex[codex.indexOf("-c") + 1], "sandbox_workspace_write.network_access=false");
  assert.ok(!findHarness("codex").run.args({ mode: "read" }).includes("-c"), "read-only has no internet to switch off");
});
