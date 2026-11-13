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

/**
 * The only tools a browser job gets: Claude in Chrome's tabs, reading, finding,
 * clicking and typing. No page scripts, no uploads, no shell, no file edits.
 */
const CHROME_TOOLS = Object.freeze([
  "mcp__claude-in-chrome__tabs_context_mcp",
  "mcp__claude-in-chrome__tabs_create_mcp",
  "mcp__claude-in-chrome__tabs_close_mcp",
  "mcp__claude-in-chrome__navigate",
  "mcp__claude-in-chrome__read_page",
  "mcp__claude-in-chrome__get_page_text",
  "mcp__claude-in-chrome__find",
  "mcp__claude-in-chrome__computer",
  "mcp__claude-in-chrome__form_input",
]);

/** OpenCode's free models need no account. This one is used when its own list cannot be read. */
const DEFAULT_FREE_MODEL = "opencode/deepseek-v4.1-flash-free";
/** Free models whose makers say they may learn from what is sent, or that are trials. Never picked by default. */
const FREE_MODELS_TO_SKIP = /big-pickle|mimo|nemotron|exo/i;
const FREE_MODEL_ORDER = [/deepseek/i, /glm/i, /minimax/i];

/** From OpenCode's own model list: a free model, DeepSeek first. Null when the list has none. */
function chooseFreeModel(listing) {
  const free = String(listing || "").split(/\r?\n/).map(line => line.trim())
    .filter(line => /^opencode\/[a-z0-9.-]+-free$/i.test(line) && !FREE_MODELS_TO_SKIP.test(line));
  for (const wanted of FREE_MODEL_ORDER) {
    const hit = free.find(name => wanted.test(name));
    if (hit) return hit;
  }
  return free[0] || null;
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
    install: { npm: "@anthropic-ai/claude-code" },
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
      // With stream on, Claude Code reports each step as it happens and the answer at the end.
      stream: "claude",
      args: ({ mode, model, stream }) => [
        "-p",
        ...(stream ? ["--output-format", "stream-json", "--verbose"] : ["--output-format", "text"]),
        "--permission-mode",
        mode === "write" ? "acceptEdits" : "plan",
        ...(model ? ["--model", model] : []),
      ],
    },
    // Works in the owner's own Chrome through the Claude in Chrome extension, where they
    // are already signed in, so no password ever passes through this app.
    browser: {
      tools: CHROME_TOOLS,
      needs: "Chrome open with the Claude extension",
      // The software checks every browser step before it runs (lib/browser-guard.cjs).
      guarded: true,
      prelude: `Your browser tools may be deferred. First call ToolSearch with "select:${CHROME_TOOLS.join(",")}".`,
      args: ({ settingsFile } = {}) => [
        "-p", "--chrome", "--output-format", "text",
        ...(settingsFile ? ["--settings", settingsFile] : []),
        "--allowedTools", ["ToolSearch", ...CHROME_TOOLS].join(","),
        "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__file_upload,mcp__claude-in-chrome__upload_image",
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
    install: { npm: "@openai/codex" },
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
      // With stream on, Codex reports each step as one JSON line and its answer as the last message.
      stream: "codex",
      // Tried in order when this account cannot use the model Codex is set to.
      fallbackModels: ["gpt-5.6-sol"],
      args: ({ mode, model, stream }) => [
        "exec",
        ...(stream ? ["--json"] : []),
        "--skip-git-repo-check",
        "--sandbox",
        mode === "write" ? "workspace-write" : "read-only",
        ...(model ? ["--model", model] : []),
        "-",
      ],
    },
    // Works in the owner's own Chrome through the Codex app and its Chrome extension.
    // Codex's browser tool runs its own script, so this app cannot check each step the
    // way it does for Claude Code. The owner is asked once before Codex is used for this.
    browser: {
      tools: [],
      needs: "the Codex app open with its Chrome extension connected",
      guarded: false,
      prelude: "Use only the chrome backend of your browser tool, which works in the owner's own signed-in Chrome. If no chrome backend is available, do not use any other browser: stop and report no_browser. Do not run shell commands or edit files.",
      args: () => ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "shell_tool", "-"],
    },
    models: [{ id: null, label: "Recommended" }],
  },
  {
    id: "antigravity",
    aliases: ["agy", "antigravity-ide"],
    // The Gemini command line is not run as an agent. Antigravity runs Gemini models and
    // takes over anything that was assigned to it, so old rows and saved choices keep working.
    replaces: ["gemini"],
    label: "Antigravity",
    hotkey: "4",
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
    hotkey: "5",
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
  {
    id: "opencode",
    aliases: ["open-code", "deepseek"],
    label: "OpenCode (free)",
    hotkey: "6",
    defaultRole: "build",
    roles: ["build", "audit", "research", "organize"],
    // Runs free models, DeepSeek first, with no account and no key. Nothing to sign in to.
    free: true,
    worker: {
      binaries: isWin ? win("opencode.exe", "opencode.cmd") : ["opencode"],
      // Older copies wait forever on today's free models (seen on 1.1.53; 1.19.5 works).
      version: { args: ["--version"], min: "1.19.0" },
    },
    signIn: { args: [] },
    authFiles: () => [],
    install: { npm: "opencode-ai" },
    run: {
      promptVia: "stdin",
      pickModel: chooseFreeModel,
      listModelsArgs: ["models"],
      defaultModel: DEFAULT_FREE_MODEL,
      // The folder is named outright. Left to work it out, a free model once wrote one folder up.
      args: ({ mode, model, cwd }) => ["run", ...(cwd ? ["--dir", cwd] : []), "--agent", mode === "write" ? "build" : "plan", "-m", model || DEFAULT_FREE_MODEL],
    },
    models: [{ id: null, label: "Free (DeepSeek first)" }],
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
  return HARNESSES.find(h => h.id === key || h.aliases.includes(key)) || HARNESSES.find(h => h.replaces?.includes(key)) || null;
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
  // Commas, semicolons and equals signs also split words in a command file, so those get quotes too.
  const quote = v => (v === "" || /[\s(),;=]/.test(v) ? `"${v}"` : v);
  const line = [`"${file}"`, ...args.map(quote)].join(" ");
  return {
    file: env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * Stops a process and everything it started. On Windows a command-file launcher
 * (claude.cmd, vercel.cmd) runs the real program as its own child, and stopping
 * only the launcher leaves that program running with nobody watching it.
 */
function stopProcessTree(child, { platform = process.platform, run = require("node:child_process").spawnSync, killGroup = process.kill } = {}) {
  if (!child) return;
  if (platform === "win32" && Number.isInteger(child.pid)) {
    try { run("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* fall through to kill */ }
  } else if (Number.isInteger(child.pid)) {
    // Started as the head of its own group (see ownGroup), so one signal reaches everything it started.
    try { killGroup(-child.pid, "SIGTERM"); } catch { /* not a group head, or already gone */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}

/** Spawn options that let stopProcessTree reach a program's children on Mac and Linux. */
function ownGroup(platform = process.platform) {
  return platform === "win32" ? {} : { detached: true };
}

/** "1.1.53" against "1.19.0": true when the installed version is older. Unknown text is never called old. */
function olderThan(installed, minimum) {
  const parts = text => /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ""))?.slice(1).map(n => Number(n || 0));
  const have = parts(installed);
  const need = parts(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] < need[i];
  return false;
}

/** True while the Node test runner is running this process. Real side effects refuse to start then. */
function underTest(env = process.env) {
  return Boolean(env.NODE_TEST_CONTEXT);
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
  stopProcessTree,
  ownGroup,
  olderThan,
  underTest,
  chooseFreeModel,
  DEFAULT_FREE_MODEL,
  pathExists,
  getAntigravityFallbackPaths,
  getCursorIdeFallbackPaths,
  getCursorWorkerFallbackPaths,
};
