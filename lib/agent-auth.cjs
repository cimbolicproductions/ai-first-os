"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

function getAntigravityFallbackPaths(homeDir = os.homedir(), env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
  return [
    path.join(localAppData, "Programs", "antigravity", "Antigravity.exe"),
    path.join(localAppData, "Programs", "Antigravity IDE", "_", "bin", "antigravity-ide.cmd"),
    path.join(localAppData, "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
    "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
    "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
    "/usr/local/bin/antigravity",
    "/usr/bin/antigravity",
  ];
}

const SUPPORTED_AGENTS = Object.freeze([
  {
    id: "claude",
    label: "Claude Code (Anthropic)",
    defaultRole: "build",
    binaries: process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude.ps1", "claude"] : ["claude"],
    loginArgs: ["login"],
  },
  {
    id: "codex",
    label: "Codex CLI (OpenAI)",
    defaultRole: "build",
    binaries: process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.ps1", "codex"] : ["codex"],
    loginArgs: ["login"],
  },
  {
    id: "gemini",
    label: "Gemini CLI (Google)",
    defaultRole: "research",
    binaries: process.platform === "win32" ? ["gemini.cmd", "gemini.ps1", "gemini"] : ["gemini"],
    loginArgs: [],
  },
  {
    id: "antigravity",
    aliases: ["agy", "antigravity-ide"],
    label: "Antigravity IDE (Google DeepMind)",
    defaultRole: "build",
    binaries:
      process.platform === "win32"
        ? ["antigravity.cmd", "antigravity.exe", "antigravity-ide.cmd", "agy.cmd", "agy.exe", "antigravity", "agy"]
        : ["antigravity", "antigravity-ide", "agy"],
    fallbackPaths: getAntigravityFallbackPaths,
    loginArgs: [],
  },
]);

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
  if (agentId === "claude") {
    return (
      fs.existsSync(path.join(homeDir, ".claude", ".credentials.json")) ||
      fs.existsSync(path.join(homeDir, ".claude.json"))
    );
  }
  if (agentId === "codex") {
    return (
      fs.existsSync(path.join(homeDir, ".codex", "auth.json")) ||
      fs.existsSync(path.join(homeDir, ".codex", "config.toml"))
    );
  }
  if (agentId === "gemini") {
    return (
      fs.existsSync(path.join(homeDir, ".gemini", "oauth_creds.json")) ||
      fs.existsSync(path.join(homeDir, ".gemini", "settings.json")) ||
      fs.existsSync(path.join(homeDir, ".gemini", "config"))
    );
  }
  if (agentId === "antigravity" || agentId === "agy") {
    return fs.existsSync(path.join(homeDir, ".gemini", "antigravity"));
  }
  return false;
}

function resolveAntigravityBinary({ execProbe = spawnSync, homeDir = os.homedir(), env = process.env } = {}) {
  const spec = SUPPORTED_AGENTS.find(a => a.id === "antigravity");
  return locateBinary(spec.binaries, execProbe, spec.fallbackPaths(homeDir, env));
}

function detectInstalledAgents({ execProbe = spawnSync, homeDir = os.homedir(), env = process.env } = {}) {
  return SUPPORTED_AGENTS.map(spec => {
    const fallbacks = typeof spec.fallbackPaths === "function" ? spec.fallbackPaths(homeDir, env) : [];
    const binaryPath = locateBinary(spec.binaries, execProbe, fallbacks);
    const signedIn = Boolean(binaryPath) && checkAuthHeuristic(spec.id, homeDir);
    return {
      id: spec.id,
      aliases: spec.aliases || [],
      label: spec.label,
      defaultRole: spec.defaultRole,
      installed: Boolean(binaryPath),
      binaryPath,
      signedIn,
      loginCommand: binaryPath ? `${spec.id}${spec.loginArgs.length ? " " + spec.loginArgs.join(" ") : ""}` : null,
    };
  });
}

function runInteractiveSignIn(agent, { execInteractive = spawnSync } = {}) {
  const spec = SUPPORTED_AGENTS.find(a => a.id === agent.id || (a.aliases || []).includes(agent.id));
  if (!spec || !agent.binaryPath) {
    return { ok: false, reason: "binary_missing" };
  }
  const res = execInteractive(agent.binaryPath, spec.loginArgs, {
    stdio: "inherit",
    shell: process.platform === "win32" && /\.(cmd|ps1)$/i.test(agent.binaryPath),
  });
  return { ok: res.status === 0, status: res.status };
}

function structureNeedsWithSignedInAgent(rawDump, signedInAgent) {
  if (!rawDump || !rawDump.trim()) return [];
  const deterministicParse = text =>
    String(text)
      .split(/[,;\r\n]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map(name => ({ name, goal: "Define bottleneck and next measurable experiment." }));

  if (!signedInAgent?.binaryPath || !signedInAgent.signedIn) {
    return deterministicParse(rawDump);
  }
  return deterministicParse(rawDump);
}

module.exports = {
  SUPPORTED_AGENTS,
  getAntigravityFallbackPaths,
  resolveAntigravityBinary,
  locateBinary,
  checkAuthHeuristic,
  detectInstalledAgents,
  runInteractiveSignIn,
  structureNeedsWithSignedInAgent,
};
