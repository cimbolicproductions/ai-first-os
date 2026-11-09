"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const {
  HARNESSES,
  findHarness,
  buildSpawnPlan,
  pathExists,
  getAntigravityFallbackPaths,
} = require("./harness-registry.cjs");

const SUPPORTED_AGENTS = HARNESSES;

function locateBinary(candidates, execProbe = spawnSync, fallbackPaths = []) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  for (const name of candidates) {
    const res = execProbe(locator, [name], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    if (res.status === 0 && res.stdout) {
      const first = res.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (first) return first;
    }
  }
  for (const fullPath of fallbackPaths) {
    if (fullPath && fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function checkAuthHeuristic(agentId, homeDir = os.homedir()) {
  const spec = findHarness(agentId);
  if (!spec) return false;
  return spec.authFiles(homeDir).some(pathExists);
}

function resolveAntigravityBinary({ execProbe = spawnSync, homeDir = os.homedir(), env = process.env } = {}) {
  const spec = findHarness("antigravity");
  return (
    locateBinary(spec.worker.binaries, execProbe) ||
    locateBinary(spec.ide.binaries, execProbe, getAntigravityFallbackPaths(homeDir, env))
  );
}

/** Asks the harness itself. Returns true, false, or null when it cannot say. */
function probeSignIn(spec, binaryPath, execProbe, env) {
  if (!spec.status || !binaryPath) return null;
  try {
    const plan = buildSpawnPlan(binaryPath, spec.status.args, { env });
    const res = execProbe(plan.file, plan.args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      ...plan.options,
    });
    if (res.error || res.status === null || res.status === undefined) return null;
    return spec.status.parse(`${res.stdout || ""}\n${res.stderr || ""}`.trim(), res.status);
  } catch {
    return null;
  }
}

function detectInstalledAgents({ execProbe = spawnSync, homeDir = os.homedir(), env = process.env } = {}) {
  return HARNESSES.map(spec => {
    const workerFallbacks = spec.worker.fallbackPaths ? spec.worker.fallbackPaths(homeDir, env) : [];
    const workerPath = locateBinary(spec.worker.binaries, execProbe, workerFallbacks);
    const idePath = spec.ide
      ? locateBinary(spec.ide.binaries, execProbe, spec.ide.fallbackPaths ? spec.ide.fallbackPaths(homeDir, env) : [])
      : null;
    const binaryPath = workerPath || idePath;
    const probed = workerPath ? probeSignIn(spec, workerPath, execProbe, env) : null;
    const signedIn = Boolean(binaryPath) && (probed === null ? spec.authFiles(homeDir).some(pathExists) : probed);
    const signInArgs = workerPath ? spec.signIn.args : [];
    return {
      id: spec.id,
      aliases: spec.aliases,
      label: spec.label,
      defaultRole: spec.defaultRole,
      installed: Boolean(binaryPath),
      binaryPath,
      workerPath,
      idePath,
      headless: Boolean(workerPath),
      signedIn,
      state: !binaryPath ? "missing" : signedIn ? "signed-in" : "installed",
      loginCommand: binaryPath ? [spec.id, ...signInArgs].join(" ") : null,
    };
  });
}

let cachedDetection = null;

/** For the dispatch path: a few seconds of probing should not repeat per row. */
function cachedDetect({ maxAgeMs = 30000 } = {}) {
  if (!cachedDetection || Date.now() - cachedDetection.at > maxAgeMs) {
    cachedDetection = { at: Date.now(), value: detectInstalledAgents() };
  }
  return cachedDetection.value;
}

function runInteractiveSignIn(agent, { execInteractive = spawnSync } = {}) {
  const spec = findHarness(agent.id);
  if (!spec || !agent.binaryPath) {
    return { ok: false, reason: "binary_missing" };
  }
  const plan = buildSpawnPlan(agent.binaryPath, agent.workerPath ? spec.signIn.args : []);
  const res = execInteractive(plan.file, plan.args, { stdio: "inherit", ...plan.options });
  return { ok: res.status === 0, status: res.status };
}

/**
 * Opens the harness's sign-in in its own terminal window so a person who clicked
 * a button in the desktop app is never asked to find a terminal.
 */
function openSignInWindow(agent, { platform = process.platform, spawnFn = spawn, env = process.env } = {}) {
  const spec = findHarness(agent.id);
  if (!spec || !agent.binaryPath) return { ok: false, reason: "binary_missing" };
  const args = agent.workerPath ? spec.signIn.args : [];
  const opts = { detached: true, stdio: "ignore" };
  let child;
  if (platform === "win32") {
    const inner = [`"${agent.binaryPath}"`, ...args].join(" ");
    child = spawnFn(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `start "Sign in" cmd /k "${inner}"`], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  } else if (platform === "darwin") {
    const line = [agent.binaryPath, ...args].join(" ").replace(/(["\\])/g, "\\$1");
    child = spawnFn("osascript", ["-e", `tell application "Terminal" to do script "${line}"`], opts);
  } else {
    child = spawnFn("x-terminal-emulator", ["-e", agent.binaryPath, ...args], opts);
  }
  if (child && typeof child.on === "function") child.on("error", () => {});
  if (child && typeof child.unref === "function") child.unref();
  return { ok: true };
}

function structureNeedsWithSignedInAgent(rawDump) {
  if (!rawDump || !rawDump.trim()) return [];
  return String(rawDump)
    .split(/[,;\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map(name => ({ name, goal: "Define bottleneck and next measurable experiment." }));
}

module.exports = {
  SUPPORTED_AGENTS,
  getAntigravityFallbackPaths,
  resolveAntigravityBinary,
  locateBinary,
  checkAuthHeuristic,
  detectInstalledAgents,
  cachedDetect,
  runInteractiveSignIn,
  openSignInWindow,
  structureNeedsWithSignedInAgent,
};
