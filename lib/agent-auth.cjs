"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HARNESSES,
  findHarness,
  buildSpawnPlan,
  pathExists,
  getAntigravityFallbackPaths,
} = require("./harness-registry.cjs");

const SUPPORTED_AGENTS = HARNESSES;

function isFullyQualified(file) {
  return path.isAbsolute(file) && (process.platform !== "win32" || path.parse(file).root.length > 1);
}

function realPath(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function locateBinary(candidates, { env = process.env, fallbackPaths = [], workspaceRoot } = {}) {
  // where.exe searches the current directory before PATH. Only check explicit
  // absolute install directories and keep project files out of sign-in probes.
  const pathKey = process.platform === "win32"
    ? Object.keys(env).find(key => key.toLowerCase() === "path")
    : "PATH";
  const directories = String(env[pathKey] || "").split(path.delimiter)
    .map(dir => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(isFullyQualified);
  const cwd = process.cwd();
  const realCwd = realPath(cwd) || cwd;
  const workspace = workspaceRoot ? path.resolve(workspaceRoot) : null;
  const realWorkspace = workspace && (realPath(workspace) || workspace);

  function installedPath(file) {
    if (!isFullyQualified(file)) return null;
    const candidate = path.resolve(file);
    if (path.relative(cwd, path.dirname(candidate)) === "" ||
        (workspace && isInside(workspace, candidate))) return null;
    try {
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return null;
      const real = realPath(candidate);
      if (!real || path.relative(realCwd, path.dirname(real)) === "" ||
          (realWorkspace && isInside(realWorkspace, real))) return null;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }

  for (const name of candidates) {
    for (const dir of directories) {
      const file = installedPath(path.join(dir, name));
      if (file) return file;
    }
  }
  for (const fullPath of fallbackPaths) {
    if (!fullPath) continue;
    const file = installedPath(fullPath);
    if (file) return file;
  }
  return null;
}

function checkAuthHeuristic(agentId, homeDir = os.homedir()) {
  const spec = findHarness(agentId);
  if (!spec) return false;
  return spec.authFiles(homeDir).some(pathExists);
}

function resolveAntigravityBinary({ homeDir = os.homedir(), env = process.env, workspaceRoot } = {}) {
  const spec = findHarness("antigravity");
  return (
    locateBinary(spec.worker.binaries, { env, workspaceRoot }) ||
    locateBinary(spec.ide.binaries, { env, workspaceRoot, fallbackPaths: getAntigravityFallbackPaths(homeDir, env) })
  );
}

/** Asks the harness itself. Returns true, false, or null when it cannot say. */
function probeSignIn(spec, binaryPath, execProbe, env) {
  if (!spec.status || !binaryPath) return null;
  try {
    const plan = buildSpawnPlan(binaryPath, spec.status.args, { env });
    const res = execProbe(plan.file, plan.args, {
      cwd: path.dirname(binaryPath),
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

function detectInstalledAgents({ execProbe = spawnSync, homeDir = os.homedir(), env = process.env, workspaceRoot } = {}) {
  return HARNESSES.map(spec => {
    const workerFallbacks = spec.worker.fallbackPaths ? spec.worker.fallbackPaths(homeDir, env) : [];
    const workerPath = locateBinary(spec.worker.binaries, { env, workspaceRoot, fallbackPaths: workerFallbacks });
    const idePath = spec.ide
      ? locateBinary(spec.ide.binaries, { env, workspaceRoot, fallbackPaths: spec.ide.fallbackPaths?.(homeDir, env) })
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
      authVerified: probed === true,
      state: !binaryPath ? "missing" : signedIn ? "signed-in" : "installed",
      loginCommand: binaryPath ? [spec.id, ...signInArgs].join(" ") : null,
    };
  });
}

let cachedDetection = null;

/** For the dispatch path: a few seconds of probing should not repeat per row. */
function cachedDetect({ maxAgeMs = 30000, workspaceRoot } = {}) {
  const workspace = workspaceRoot ? path.resolve(workspaceRoot) : null;
  if (!cachedDetection || cachedDetection.workspace !== workspace ||
      cachedDetection.cwd !== process.cwd() || Date.now() - cachedDetection.at > maxAgeMs) {
    cachedDetection = { at: Date.now(), workspace, cwd: process.cwd(), value: detectInstalledAgents({ workspaceRoot: workspace }) };
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
