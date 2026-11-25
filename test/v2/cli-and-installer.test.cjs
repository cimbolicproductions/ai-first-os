"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseArgs, runInitProfile, runStatus, runDoctor } = require("../../bin/aios.cjs");
const { buildInstallers, parseSums, collectFiles } = require("../../scripts/build-installer.cjs");
const { PURCHASE_PHRASES, isPurchaseCommand, openCodeConfig, claudeSettings } = require("../../lib/no-purchase.cjs");
const { createRelay, sha256Hex } = require("../../lib/relay-core.cjs");
const { planAutostart } = require("../../lib/autostart.cjs");
const { storeSecret, readSecret, clearSecretCache } = require("../../lib/keyring.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "aios.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("CLI init, doctor, status, chat, pause/resume, logs, and models work cleanly", () => {
  const tmp = mkTmp("aios-cli-");
  const profileDir = path.join(tmp, "profile");
  const fakeRepo = path.join(tmp, "repos", "demo-app");
  fs.mkdirSync(path.join(fakeRepo, ".git"), { recursive: true });

  const initRes = runInitProfile({
    profileDir,
    owner: "Tester",
    roots: [path.join(tmp, "repos")],
    tailscale: "198.51.100.42",
  });
  assert.equal(initRes.ok, true);
  assert.equal(initRes.profile.owner, "Tester");

  const doc = runDoctor({
    profileDir,
    detect: () => [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, headless: true }],
  });
  assert.equal(doc.ok, true);
  assert.equal(doc.projectsCount, 1);

  const runCli = args => spawnSync(process.execPath, ["--no-warnings", CLI, ...args, "--profile-dir", profileDir], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });

  const chatRes = runCli(["chat", "Build landing page for demo-app"]);
  assert.equal(chatRes.status, 0, chatRes.stderr);
  const created = JSON.parse(chatRes.stdout);
  assert.equal(created.ok, true);
  assert.equal(created.task.projectName, "demo-app");

  const pauseRes = runCli(["pause"]);
  assert.equal(pauseRes.status, 0);
  assert.equal(JSON.parse(pauseRes.stdout).queuePaused, true);

  const resumeRes = runCli(["resume"]);
  assert.equal(resumeRes.status, 0);
  assert.equal(JSON.parse(resumeRes.stdout).queuePaused, false);

  const logsRes = runCli(["logs", created.task.id, "--json"]);
  assert.equal(logsRes.status, 0, logsRes.stderr);
  const logs = JSON.parse(logsRes.stdout);
  assert.equal(logs.task.id, created.task.id);
  assert.equal(logs.thread.length, 1);

  const modelsRes = runCli(["models", "--json"]);
  assert.equal(modelsRes.status, 0, modelsRes.stderr);
  assert.ok(JSON.parse(modelsRes.stdout).models.length >= 6);

  const status = runStatus({
    profileDir,
    detect: () => [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, headless: true }],
  });
  assert.equal(status.counts.active, 1);
  assert.equal(parseArgs(["desktop", "--port", "4444", "--no-window"]).flags.port, 4444);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("installer builder bundles v2 files without legacy bloat", () => {
  const files = collectFiles();
  assert.ok(files["bin/aios.cjs"]);
  assert.ok(files["lib/v2/daemon.cjs"]);
  assert.ok(files["lib/ui/index.html"]);
  assert.ok(files["assets/logo-512.png"]);

  const sumsText = [
    `${"a".repeat(64)}  node-v22.17.0-win-x64.zip`,
    `${"b".repeat(64)}  node-v22.17.0-win-arm64.zip`,
    `${"c".repeat(64)}  node-v22.17.0-darwin-x64.tar.gz`,
    `${"d".repeat(64)}  node-v22.17.0-darwin-arm64.tar.gz`,
    `${"e".repeat(64)}  node-v22.17.0-linux-x64.tar.gz`,
    `${"f".repeat(64)}  node-v22.17.0-linux-arm64.tar.gz`,
  ].join("\n");
  const parsed = parseSums(sumsText);
  assert.equal(parsed.version, "22.17.0");

  const outDir = mkTmp("aios-dist-");
  const outputs = buildInstallers({ outDir, version: parsed.version, sums: parsed.sums });
  assert.ok(fs.existsSync(outputs.win32));
  assert.ok(fs.existsSync(outputs.darwin));
  assert.ok(fs.existsSync(outputs.linux));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("preserved core guards: no-purchase, relay queuePaused, autostart v2, and keyring", async () => {
  assert.ok(PURCHASE_PHRASES.length > 0);
  assert.equal(isPurchaseCommand("vercel domains buy example.com"), true);
  assert.equal(isPurchaseCommand("npm test"), false);
  assert.ok(JSON.parse(openCodeConfig()).permission);
  assert.ok(claudeSettings().hooks);

  const mem = new Map();
  const store = {
    async add(kind, body) { return { id: 1, kind, body }; },
    async list() { return []; },
    async consume() {},
    async getState(k) { return mem.get(k) ?? null; },
    async setState(k, v) { mem.set(k, v); },
    async claimState(k, v) { if (mem.has(k)) return { created: false, value: mem.get(k) }; mem.set(k, v); return { created: true, value: v }; },
  };
  const phoneToken = "p".repeat(32);
  const homeToken = "h".repeat(32);
  const relay = createRelay({
    store,
    phoneTokenHash: await sha256Hex(phoneToken),
    homeTokenHash: await sha256Hex(homeToken),
  });
  const hb = await relay.handle({
    method: "POST",
    path: "/v1/heartbeat",
    headers: { authorization: `Bearer ${homeToken}` },
    body: { machine: "dev", queuePaused: true },
  });
  assert.equal(hb.status, 200);
  const st = await relay.handle({
    method: "GET",
    path: "/v1/status",
    headers: { authorization: `Bearer ${phoneToken}` },
  });
  assert.equal(st.status, 200);
  assert.equal(st.body.queuePaused, true);

  const plan = planAutostart({ cliPath: "/app/bin/aios.cjs", profileDir: "/home/u/.aios", homeDir: "/home/u", platform: "linux" });
  assert.ok(plan.files[0].content.includes("--profile-dir"));

  clearSecretCache();
  let calls = 0;
  const fakeExec = () => { calls++; return { status: 0, stdout: Buffer.from("secret-val").toString("base64") }; };
  assert.equal(readSecret("TEST_SECRET_KEY", { platform: "win32", env: {}, execProbe: fakeExec }), "secret-val");
  assert.equal(calls, 1);
  assert.equal(storeSecret("TEST_SECRET_KEY", "abc", { platform: "win32", execProbe: () => ({ status: 0 }) }).stored, true);
});
