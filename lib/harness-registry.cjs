"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * The open harness list. Everything the OS knows about an agent harness lives
 * in one entry here: how to find it, how to tell whether it is signed in, how to
 * sign in, how to hand it work, which models it offers, and which key switches
 * to it. A new harness is a new entry; nothing else in the OS changes.
 *
 * worker: the command-line program that can run a task and report back.
 * ide:    a desktop app that can only be opened on the work (no report back).
 */

const isWin = process.platform === "win32";
const win = (...names) => names;

function localAppData(homeDir, env) {
  return env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
}

function getAntigravityFallbackPaths(homeDir = os.homedir(), env = process.env) {
  const local = localAppData(homeDir, env);
  return [
    path.join(local, "Programs", "antigravity", "Antigravity.exe"),
    path.join(local, "Programs", "Antigravity IDE", "_", "bin", "antigravity-ide.cmd"),
    path.join(local, "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
    "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
    "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
    "/usr/local/bin/antigravity",
    "/usr/bin/antigravity",
  ];
}

function getCursorIdeFallbackPaths(homeDir = os.homedir(), env = process.env) {
  const local = localAppData(homeDir, env);
  return [
    path.join(local, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
    path.join(local, "Programs", "cursor", "Cursor.exe"),
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    "/usr/local/bin/cursor",
    "/usr/bin/cursor",
  ];
}

function getCursorWorkerFallbackPaths(homeDir = os.homedir(), env = process.env) {
  const local = localAppData(homeDir, env);
  return [
    path.join(local, "cursor-agent", "agent.cmd"),
    path.join(local, "cursor-agent", "cursor-agent.cmd"),
    path.join(homeDir, ".local", "bin", "cursor-agent"),
    path.join(homeDir, ".local", "bin", "agent"),
  ];
}

const HARNESSES = Object.freeze([
  {
    id: "claude",
    aliases: [],
    label: "Claude Code",
    hotkey: "2",
    defaultRole: "build",
    roles: ["build", "audit", "research", "organize"],
    worker: { binaries: isWin ? win("claude.exe", "claude.cmd") : ["claude"] },
    signIn: { args: ["auth", "login"] },
    status: {
      args: ["auth", "status"],
      parse(out) {
        try {
          return JSON.parse(out).loggedIn === true;
        } catch {
          return null;
        }
      },
    },
    authFiles: home => [path.join(home, ".claude", ".credentials.json"), path.join(home, ".claude.json")],
    run: {
      promptVia: "stdin",
      env: { CLAUDE_HEADLESS_WORKER: "1" },
      args: ({ mode, model }) => [
        "-p",
        "--output-format",
        "text",
        "--permission-mode",
        mode === "write" ? "acceptEdits" : "plan",
        ...(model ? ["--model", model] : []),
      ],
    },
    models: [
      { id: null, label: "Recommended" },
      { id: "opus", label: "Opus (strongest)" },
      { id: "sonnet", label: "Sonnet (balanced)" },
    ],
  },
  {
    id: "codex",
    aliases: [],
    label: "Codex",
    hotkey: "3",
    defaultRole: "build",
    roles: ["build", "audit", "research", "organize"],
    worker: { binaries: isWin ? win("codex.exe", "codex.cmd") : ["codex"] },
    signIn: { args: ["login"] },
    status: {
      args: ["login", "status"],
      parse(out, code) {
        if (code !== 0) return false;
        return /logged in/i.test(out) && !/not logged in/i.test(out);
      },
    },
    authFiles: home => [path.join(home, ".codex", "auth.json")],
    run: {
      promptVia: "stdin",
      args: ({ mode, model }) => [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        mode === "write" ? "workspace-write" : "read-only",
        ...(model ? ["--model", model] : []),
        "-",
      ],
    },
    models: [{ id: null, label: "Recommended" }],
  },
  {
    id: "gemini",
    aliases: [],
    label: "Gemini",
    hotkey: "4",
    defaultRole: "research",
    roles: ["research", "audit", "organize", "build"],
    worker: { binaries: isWin ? win("gemini.exe", "gemini.cmd") : ["gemini"] },
    signIn: { args: [] },
    authFiles: home => [path.join(home, ".gemini", "oauth_creds.json")],
    run: {
      promptVia: "stdin",
      args: ({ mode, model }) => [
        "-p",
        "Follow the work order on stdin.",
        "--approval-mode", mode === "write" ? "auto_edit" : "plan",
        ...(model ? ["--model", model] : []),
      ],
    },
    models: [{ id: null, label: "Recommended" }],
  },
  {
    id: "antigravity",
    aliases: ["agy", "antigravity-ide"],
    label: "Antigravity",
    hotkey: "5",
    defaultRole: "build",
    roles: ["build", "audit", "research", "organize"],
    worker: { binaries: isWin ? win("agy.exe") : ["agy"] },
    ide: {
      binaries: isWin
        ? win("antigravity.cmd", "antigravity.exe", "antigravity-ide.cmd")
        : ["antigravity", "antigravity-ide"],
      fallbackPaths: getAntigravityFallbackPaths,
      openArgs: (cwd, file) => [cwd, file],
    },
    signIn: { args: [] },
    authFiles: home => [path.join(home, ".gemini", "antigravity")],
    run: {
      promptVia: "file",
      args: ({ mode, model, cwd }) => [
        "--print-timeout",
        "30m",
        "--mode",
        mode === "write" ? "accept-edits" : "plan",
        "--add-dir",
        cwd,
        ...(model ? ["--model", model] : []),
        "-p",
      ],
    },
    models: [
      { id: null, label: "Recommended" },
      { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
    ],
  },
  {
    id: "cursor",
    aliases: ["cursor-agent"],
    label: "Cursor",
    hotkey: "6",
    defaultRole: "build",
    roles: ["build", "audit", "research", "organize"],
    worker: {
      binaries: isWin
        ? win("cursor-agent.cmd", "cursor-agent.exe", "agent.cmd", "agent.exe")
        : ["cursor-agent", "agent"],
      fallbackPaths: getCursorWorkerFallbackPaths,
    },
    ide: {
      binaries: isWin ? win("cursor.cmd", "cursor.exe") : ["cursor"],
      fallbackPaths: getCursorIdeFallbackPaths,
      openArgs: (cwd, file) => [cwd, file],
    },
    signIn: { args: ["login"] },
    status: {
      args: ["status"],
      parse(out, code) {
        if (code !== 0) return false;
        return /(logged in|signed in|authenticated)/i.test(out) && !/not (logged|signed|authenticated)/i.test(out);
      },
    },
    authFiles: () => [],
    run: {
      promptVia: "file",
      args: ({ mode, model }) => [
        "--print",
        "--output-format",
        "text",
        ...(mode === "write" ? ["--force"] : ["--mode=ask"]),
        ...(model ? ["--model", model] : []),
      ],
    },
    models: [{ id: null, label: "Recommended" }],
  },
]);

/**
 * Personal agents live on the phone or in the cloud. They cannot be detected or
 * launched here; they read and write the board through the phone link.
 */
const PERSONAL_AGENTS = Object.freeze([
  { id: "muse", label: "Muse", kind: "personal", roles: ["organize"] },
  { id: "grokbot", label: "GrokBot", kind: "personal", roles: ["organize"] },
]);

function findHarness(id) {
  const key = String(id || "").toLowerCase();
  return HARNESSES.find(h => h.id === key || h.aliases.includes(key)) || null;
}

function findPersonalAgent(id) {
  const key = String(id || "").toLowerCase();
  return PERSONAL_AGENTS.find(a => a.id === key) || null;
}

function labelFor(id) {
  return findHarness(id)?.label || findPersonalAgent(id)?.label || String(id || "");
}

/** Lanes for every surface, so one-move switching stays identical everywhere. */
function laneList() {
  return [
    { id: "board", key: "1", label: "Board" },
    ...HARNESSES.map(h => ({ id: h.id, key: h.hotkey, label: h.label })),
  ];
}

function isShim(file) {
  return /\.(cmd|bat)$/i.test(String(file || ""));
}

/**
 * Builds a spawn plan that runs batch-file shims through cmd.exe without ever
 * placing board or user text on the command line. Only fixed flags, model names
 * and paths may reach here; anything else is refused rather than quoted.
 */
function buildSpawnPlan(file, args, { env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32" || !isShim(file)) {
    return { file, args, options: {} };
  }
  for (const value of [file, ...args]) {
    if (/["%^&|<>\r\n]/.test(value)) {
      throw Object.assign(new Error("Refusing unsafe text on a Windows command line."), { code: "UNSAFE_COMMAND_LINE" });
    }
  }
  const quote = v => (v === "" || /[\s()]/.test(v) ? `"${v}"` : v);
  const line = [`"${file}"`, ...args.map(quote)].join(" ");
  return {
    file: env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function pathExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

module.exports = {
  HARNESSES,
  PERSONAL_AGENTS,
  findHarness,
  findPersonalAgent,
  labelFor,
  laneList,
  isShim,
  buildSpawnPlan,
  pathExists,
  getAntigravityFallbackPaths,
  getCursorIdeFallbackPaths,
  getCursorWorkerFallbackPaths,
};
