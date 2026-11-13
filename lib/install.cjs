"use strict";

const { spawn } = require("node:child_process");
const { locateBinary } = require("./agent-auth.cjs");
const { HARNESSES, buildSpawnPlan, stopProcessTree, ownGroup, underTest } = require("./harness-registry.cjs");

/**
 * Getting a missing tool onto the computer from inside the app: an agent, or the
 * sign-in tool a service needs. It only ever starts from the owner pressing
 * Install or Update, it only installs what is listed here, and every one of them
 * is free. The package names are fixed; nothing anyone typed reaches a command.
 */
const isWin = process.platform === "win32";
const SERVICE_TOOLS = Object.freeze({
  vercel: { label: "Vercel's sign-in tool", npm: "vercel" },
  github: {
    label: "GitHub's sign-in tool",
    winget: "GitHub.cli",
    brew: "gh",
  },
});

/** What can be installed, by id: every agent that names a package, plus the service tools. */
function installable(id) {
  const harness = HARNESSES.find(h => h.id === id);
  if (harness?.install) return { id, label: harness.label, ...harness.install };
  return SERVICE_TOOLS[id] ? { id, ...SERVICE_TOOLS[id] } : null;
}

/** The one command that installs it on this kind of computer, or null when there is none. */
function installCommand(tool, { platform = process.platform, locate = locateBinary } = {}) {
  if (tool.npm) {
    const npm = locate(platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"]);
    return npm ? { file: npm, args: ["install", "-g", `${tool.npm}@latest`] } : null;
  }
  if (platform === "win32" && tool.winget) {
    const winget = locate(["winget.exe"]);
    return winget ? { file: winget, args: ["install", "--id", tool.winget, "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"] } : null;
  }
  if (platform !== "win32" && tool.brew) {
    const brew = locate(["brew"]);
    return brew ? { file: brew, args: ["install", tool.brew] } : null;
  }
  return null;
}

function runQuiet({ file, args }, { spawnFn = spawn, timeoutMs = 10 * 60000 } = {}) {
  return new Promise(resolve => {
    // A test never installs anything, even when it forgets to pass its stand-in.
    if (underTest() && spawnFn === spawn) return resolve({ code: 125, refused: true, output: "" });
    let plan;
    try { plan = buildSpawnPlan(file, args); } catch { return resolve({ code: 126, output: "" }); }
    const child = spawnFn(plan.file, plan.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...ownGroup(), ...plan.options });
    let output = "";
    const timer = setTimeout(() => stopProcessTree(child), timeoutMs);
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: 127, output }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

const running = new Map();

/**
 * Installs or updates one listed tool. Settles with { ok: true, label } or
 * { ok: false, label, reason }: "unknown", "no_installer" (nothing on this
 * computer can install it) or "failed".
 */
function installTool(id, { run = runQuiet, platform = process.platform, locate = locateBinary, afterInstall = () => {} } = {}) {
  const tool = installable(id);
  if (!tool) return Promise.resolve({ ok: false, label: String(id), reason: "unknown" });
  if (running.has(id)) return running.get(id);
  const command = installCommand(tool, { platform, locate });
  if (!command) return Promise.resolve({ ok: false, label: tool.label, reason: "no_installer" });
  const job = run(command).then(done => {
    if (done.code !== 0) return { ok: false, label: tool.label, reason: "failed" };
    try { afterInstall(); } catch { /* the next check finds it anyway */ }
    return { ok: true, label: tool.label };
  }).catch(() => ({ ok: false, label: tool.label, reason: "failed" })).finally(() => running.delete(id));
  running.set(id, job);
  return job;
}

module.exports = { installTool, installable, installCommand, SERVICE_TOOLS, isWin };
