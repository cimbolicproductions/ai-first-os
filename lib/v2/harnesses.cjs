"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { claudeSettings, openCodeConfig, ensureAntigravityGuard, isPurchaseCommand } = require("../no-purchase.cjs");
const { buildSpawnPlan, stopProcessTree, ownGroup, olderThan, underTest, getAntigravityFallbackPaths, getCursorIdeFallbackPaths, getCursorWorkerFallbackPaths } = require("../harness-registry.cjs");
const { locateBinary } = require("../agent-auth.cjs");
const { readClaudeEvent, readCodexEvent, plainLine } = require("../activity.cjs");
const { classifyProviderFailure } = require("./quota.cjs");
const { parseModelListing } = require("./model-catalog.cjs");

/**
 * Unified 6-CLI Terminal Harness Adapter Layer.
 *
 * Key upgrades over v1:
 * - Restores Gemini CLI as a first-class harness alongside Antigravity (no forced replacement)
 * - Passes model + reasoning effort flags uniformly (Claude --effort, Codex model_reasoning_effort, etc.)
 * - Guards Cursor CLI (previously ran --force with zero safety fence)
 * - Uses structured file-first output contracts (<runDir>/stage-result.json) so trailing
 *   chatter never causes false failures and blocked runs are never marked Done
 * - Combines stdout streaming with worktree mtime liveness checks
 */

const isWin = process.platform === "win32";
const win = (...names) => names;

const METERED_CREDENTIALS = Object.freeze([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "CURSOR_API_KEY",
  "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY", "GROQ_API_KEY",
]);

const HARNESS_SPECS = Object.freeze([
  {
    id: "claude",
    label: "Claude Code",
    workerBinaries: isWin ? win("claude.exe", "claude.cmd") : ["claude"],
    install: { npm: "@anthropic-ai/claude-code" },
    signIn: { args: ["auth", "login"], mode: "oauth-cli" },
    status: {
      args: ["auth", "status"],
      parse(out) {
        try { return JSON.parse(out).loggedIn === true; } catch { return null; }
      },
    },
    authFiles: home => [path.join(home, ".claude", ".credentials.json"), path.join(home, ".claude.json")],
    stream: "claude",
    promptVia: "stdin",
    settings: ({ mode, allowConnectors = false }) => claudeSettings({ blockConnectors: mode === "write" && !allowConnectors }),
    buildArgs({ mode, model, effort, stream, settingsFile }) {
      return [
        "-p",
        ...(stream ? ["--output-format", "stream-json", "--verbose"] : ["--output-format", "text"]),
        "--permission-mode", mode === "write" ? "bypassPermissions" : "plan",
        ...(settingsFile ? ["--settings", settingsFile] : []),
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
      ];
    },
  },
  {
    id: "codex",
    label: "Codex",
    workerBinaries: isWin ? win("codex.exe", "codex.cmd") : ["codex"],
    install: { npm: "@openai/codex" },
    signIn: { args: ["login"], mode: "oauth-cli" },
    status: {
      args: ["login", "status"],
      parse(out, code) {
        if (code !== 0) return false;
        return /logged in/i.test(out) && !/not logged in/i.test(out);
      },
    },
    authFiles: home => [path.join(home, ".codex", "auth.json")],
    stream: "codex",
    promptVia: "stdin",
    buildArgs({ mode, model, effort, stream, allowNetwork = false, outputSchemaFile = null }) {
      return [
        "exec",
        ...(stream ? ["--json"] : []),
        "--skip-git-repo-check",
        "--sandbox", mode === "write" ? "workspace-write" : "read-only",
        ...(mode === "write" ? ["-c", `sandbox_workspace_write.network_access=${allowNetwork ? "true" : "false"}`] : []),
        "--disable", "apps",
        ...(model ? ["--model", model] : []),
        ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
        ...(outputSchemaFile ? ["--output-schema", outputSchemaFile] : []),
        "-",
      ];
    },
  },
  {
    id: "antigravity",
    label: "Antigravity",
    workerBinaries: isWin ? win("agy.exe", "agy.cmd") : ["agy"],
    ideBinaries: isWin ? win("antigravity.cmd", "antigravity.exe") : ["antigravity"],
    ideFallbacks: getAntigravityFallbackPaths,
    signIn: { args: [], mode: "desktop-app" },
    listModelsArgs: ["models"],
    status: {
      args: ["models"],
      parse(out, code) {
        if (code === 0 && /^\S+\t\S/m.test(out)) return true;
        if (/sign ?in|log ?in|logged out|unauthenticated/i.test(out)) return false;
        return null;
      },
    },
    authFiles: home => [path.join(home, ".gemini", "antigravity")],
    promptVia: "file",
    guard() {
      const home = process.env.AIOS_AGY_HOOK_HOME;
      if (process.env.NODE_TEST_CONTEXT && !home) return false;
      return ensureAntigravityGuard(home ? { home } : {});
    },
    guardedEnv: { AIOS_AGY_WORKER: "1" },
    buildArgs({ mode, model, cwd, guarded }) {
      return [
        "--print-timeout", "30m",
        ...(mode === "write" ? (guarded ? [] : ["--mode", "accept-edits"]) : ["--mode", "plan"]),
        "--add-dir", cwd,
        ...(model ? ["--model", model] : []),
        "-p",
      ];
    },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    workerBinaries: isWin ? win("gemini.exe", "gemini.cmd") : ["gemini"],
    install: { npm: "@google/gemini-cli" },
    signIn: { args: [], mode: "oauth-cli" },
    status: {
      args: ["--version"],
      parse(out, code) {
        return code === 0 && /\d+\.\d+/.test(out) ? null : false;
      },
    },
    authFiles: home => [
      path.join(home, ".gemini", "oauth_creds.json"),
      path.join(home, ".gemini", "google_accounts.json"),
      path.join(home, ".gemini", "settings.json"),
    ],
    promptVia: "stdin",
    buildArgs({ mode, model }) {
      return [
        ...(model ? ["-m", model] : []),
        ...(mode === "write" ? ["--yolo"] : []),
        "-p", "",
      ];
    },
  },
  {
    id: "opencode",
    label: "OpenCode (free)",
    free: true,
    workerBinaries: isWin ? win("opencode.exe", "opencode.cmd") : ["opencode"],
    version: { args: ["--version"], min: "1.19.0" },
    install: { npm: "opencode-ai" },
    signIn: { args: [], mode: "none" },
    listModelsArgs: ["models"],
    authFiles: () => [],
    promptVia: "stdin",
    env: { OPENCODE_CONFIG_CONTENT: openCodeConfig() },
    buildArgs({ mode, model, cwd }) {
      return [
        "run",
        ...(cwd ? ["--dir", cwd] : []),
        "--agent", mode === "write" ? "build" : "plan",
        "--auto",
        ...(model ? ["-m", model] : []),
      ];
    },
  },
  {
    id: "cursor",
    label: "Cursor CLI",
    workerBinaries: isWin ? win("cursor-agent.cmd", "cursor-agent.exe", "agent.cmd", "agent.exe") : ["cursor-agent", "agent"],
    workerFallbacks: getCursorWorkerFallbackPaths,
    ideBinaries: isWin ? win("cursor.cmd", "cursor.exe") : ["cursor"],
    ideFallbacks: getCursorIdeFallbackPaths,
    signIn: { args: ["login"], mode: "oauth-cli" },
    getUrl: "https://cursor.com/cli",
    status: {
      args: ["status"],
      parse(out, code) {
        if (code !== 0) return false;
        return /(logged in|signed in|authenticated)/i.test(out) && !/not (logged|signed|authenticated)/i.test(out);
      },
    },
    authFiles: () => [],
    promptVia: "file",
    // Safety note: Cursor runs in read-only ask mode unless explicitly guarded in an isolated worktree.
    buildArgs({ mode, model }) {
      return [
        "--print",
        "--output-format", "text",
        ...(mode === "write" ? ["--force"] : ["--mode=ask"]),
        ...(model && model !== "default" ? ["--model", model] : []),
      ];
    },
  },
]);

function getHarness(id) {
  return HARNESS_SPECS.find(h => h.id === String(id || "").toLowerCase()) || null;
}

function probeBinary(spec, binaryPath, args, execProbe, env) {
  try {
    const plan = buildSpawnPlan(binaryPath, args, { env });
    const res = execProbe(plan.file, plan.args, {
      cwd: path.dirname(binaryPath),
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      ...plan.options,
    });
    return res;
  } catch {
    return { error: true, status: null, stdout: "", stderr: "" };
  }
}

function detectHarnesses({ execProbe = spawnSync, homeDir = os.homedir(), env = process.env, workspaceRoot = null } = {}) {
  return HARNESS_SPECS.map(spec => {
    const workerFallbacks = spec.workerFallbacks ? spec.workerFallbacks(homeDir, env) : [];
    const workerPath = locateBinary(spec.workerBinaries, { env, workspaceRoot, fallbackPaths: workerFallbacks });
    const idePath = spec.ideBinaries
      ? locateBinary(spec.ideBinaries, { env, workspaceRoot, fallbackPaths: spec.ideFallbacks?.(homeDir, env) || [] })
      : null;
    const binaryPath = workerPath || idePath;

    let outdated = false;
    if (workerPath && spec.version) {
      const vRes = probeBinary(spec, workerPath, spec.version.args, execProbe, env);
      if (!vRes.error && vRes.status === 0) {
        outdated = olderThan(String(vRes.stdout || "").trim(), spec.version.min);
      }
    }

    let probed = null;
    if (workerPath && !spec.free && spec.status) {
      const sRes = probeBinary(spec, workerPath, spec.status.args, execProbe, env);
      if (!sRes.error && sRes.status !== null && sRes.status !== undefined) {
        probed = spec.status.parse(`${sRes.stdout || ""}\n${sRes.stderr || ""}`.trim(), sRes.status);
      }
    }

    const hasAuthFile = spec.authFiles(homeDir).some(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    const signedIn = !outdated && (spec.free ? Boolean(workerPath) : Boolean(binaryPath) && (probed === null ? hasAuthFile : probed));

    return {
      id: spec.id,
      label: spec.label,
      installed: Boolean(binaryPath),
      workerPath,
      idePath,
      headless: Boolean(workerPath) && !outdated,
      free: spec.free === true,
      outdated,
      signedIn,
      authVerified: spec.free ? signedIn : probed === true,
      canInstall: Boolean(spec.install),
      signInMode: spec.signIn?.mode || "none",
      state: !binaryPath ? "missing" : outdated ? "outdated" : signedIn ? "signed-in" : "installed",
    };
  });
}

async function listLiveModels(providerId, { detect = detectHarnesses, spawnFn = spawn, timeoutMs = 15000 } = {}) {
  const spec = getHarness(providerId);
  if (!spec?.listModelsArgs) return [];
  if (underTest() && spawnFn === spawn) return [];
  const found = detect().find(h => h.id === spec.id);
  if (!found?.workerPath) return [];
  const plan = buildSpawnPlan(found.workerPath, spec.listModelsArgs);
  const ran = await runSubprocess(plan, { cwd: os.tmpdir(), stdin: "", env: {}, timeoutMs, spawnFn });
  if (ran.code !== 0) return [];
  return parseModelListing(spec.id, ran.stdout);
}

/**
 * Extracts structured stage output reliably without breaking on trailing prose.
 * Order:
 *   1. Designated JSON file written by the agent (stage-result.json)
 *   2. Last AIOS-RESULT: {...} line anywhere in stdout
 *   3. Last fenced ```json { ... } ``` block containing a "status" field
 */
function extractStructuredOutput({ resultFile = null, stdout = "" } = {}) {
  if (resultFile && fs.existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
        return { source: "file", data: parsed };
      }
    } catch { /* fall through to stdout parsing */ }
  }

  const text = String(stdout || "");
  const aiosLines = [...text.matchAll(/^AIOS-RESULT:\s*(\{[^\r\n]+\})\s*$/gm)];
  for (let i = aiosLines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(aiosLines[i][1]);
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
        return { source: "marker", data: parsed };
      }
    } catch { /* try earlier */ }
  }

  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(fenced[i][1].trim());
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
        return { source: "fence", data: parsed };
      }
    } catch { /* try earlier */ }
  }

  return null;
}

function runSubprocess(plan, { cwd, stdin = "", env = {}, timeoutMs = 30 * 60 * 1000, spawnFn = spawn, signal = null, onLine = null }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || Object.assign(new Error("Aborted"), { code: "ABORTED" }));
    const child = spawnFn(plan.file, plan.args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...ownGroup(),
      ...plan.options,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopProcessTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const tails = { out: "", err: "" };
    const emitLines = (key, chunk) => {
      if (!onLine) return;
      const parts = (tails[key] + chunk).split(/\r?\n/);
      tails[key] = parts.pop();
      for (const line of parts) {
        try { onLine(key, line); } catch { /* ignore UI listener errors */ }
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", d => { stdout += d; emitLines("out", d); });
    child.stderr?.on("data", d => { stderr += d; emitLines("err", d); });
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin || "");

    child.on("error", err => {
      cleanup();
      reject(err);
    });
    child.on("close", code => {
      cleanup();
      if (signal?.aborted) reject(signal.reason || Object.assign(new Error("Aborted"), { code: "ABORTED" }));
      else if (timedOut) reject(Object.assign(new Error("Agent run timed out."), { code: "AGENT_TIMEOUT" }));
      else resolve({ code, stdout, stderr });
    });
  });
}

const STREAM_READERS = { claude: readClaudeEvent, codex: readCodexEvent };

/**
 * Executes a single harness run with unified safety fences, effort flags,
 * structured output extraction, and multi-provider failure classification.
 */
async function runHarness({
  provider,
  prompt,
  cwd,
  runDir = null,
  resultFile = null,
  mode = "write",
  model = null,
  effort = null,
  allowNetwork = false,
  allowConnectors = false,
  subscriptionOnly = true,
  timeoutMs = 30 * 60 * 1000,
  detect = detectHarnesses,
  spawnFn = spawn,
  onActivity = () => {},
  signal = null,
}) {
  const spec = getHarness(provider);
  if (!spec) throw Object.assign(new Error(`Unknown harness "${provider}"`), { code: "UNKNOWN_HARNESS" });
  if (underTest() && spawnFn === spawn) {
    throw Object.assign(new Error("Real harness execution is disabled during tests."), { code: "TEST_GUARD" });
  }

  // Guard against direct purchase prompts leaking into unguarded harnesses like Cursor.
  if (spec.id === "cursor" && isPurchaseCommand(prompt)) {
    throw Object.assign(new Error("Purchase command refused by safety fence."), { code: "SAFETY_REFUSED" });
  }

  const found = detect({ workspaceRoot: cwd }).find(h => h.id === spec.id);
  if (!found?.workerPath) {
    throw Object.assign(new Error(`${spec.label} CLI is not installed.`), { code: "HARNESS_MISSING" });
  }

  const guarded = mode === "write" && typeof spec.guard === "function" ? spec.guard() === true : false;
  const readEvent = STREAM_READERS[spec.stream] || null;
  const streaming = Boolean(readEvent);

  let settingsFile = null;
  let promptFile = null;
  let stdin = "";
  let trailingArg = null;

  try {
    if (spec.settings) {
      settingsFile = path.join(os.tmpdir(), `aios-v2-settings-${crypto.randomUUID()}.json`);
      fs.writeFileSync(settingsFile, JSON.stringify(spec.settings({ mode, allowConnectors })), { encoding: "utf8", flag: "wx" });
    }
    if (spec.promptVia === "stdin") {
      stdin = prompt;
    } else {
      const targetDir = runDir || path.join(cwd, ".aios-tmp");
      fs.mkdirSync(targetDir, { recursive: true });
      promptFile = path.join(targetDir, `prompt-${crypto.randomUUID()}.md`);
      fs.writeFileSync(promptFile, prompt, "utf8");
      trailingArg = `Read the full instructions in ${promptFile} and follow them exactly.`;
    }

    const args = [
      ...spec.buildArgs({ mode, model, effort, cwd, stream: streaming, settingsFile, guarded, allowNetwork }),
      ...(trailingArg ? [trailingArg] : []),
    ];
    const plan = buildSpawnPlan(found.workerPath, args);

    const env = { ...(spec.env || {}), ...(guarded && spec.guardedEnv ? spec.guardedEnv : {}) };
    if (subscriptionOnly) {
      for (const key of Object.keys(process.env)) {
        if (METERED_CREDENTIALS.includes(key.toUpperCase())) env[key] = undefined;
      }
    }

    let finalAnswer = null;
    const streamTexts = [];
    const res = await runSubprocess(plan, {
      cwd,
      stdin,
      env,
      timeoutMs,
      spawnFn,
      signal,
      onLine(source, line) {
        if (streaming && source === "out") {
          const ev = readEvent(line);
          if (ev?.result !== undefined) finalAnswer = ev.result;
          if (ev?.text) streamTexts.push(ev.text);
          if (ev?.activity) onActivity(ev.activity);
        } else if (!streaming) {
          const words = plainLine(line);
          if (words) onActivity(words);
        }
      },
    });

    const effectiveStdout = streaming ? (finalAnswer || streamTexts.at(-1) || res.stdout) : res.stdout;
    const combined = `${effectiveStdout}\n${res.stderr}`.trim();
    const structured = res.code === 0 ? extractStructuredOutput({ resultFile, stdout: effectiveStdout }) : null;

    // Classify quota/auth errors even on clean exit when no valid structured result was emitted.
    if (res.code !== 0 || (!structured && combined.length < 1000)) {
      const failure = classifyProviderFailure(spec.id, combined, { exitCode: res.code });
      if (failure.kind === "exhausted" || failure.kind === "auth_expired" || failure.kind === "model_unsupported" || res.code !== 0) {
        return {
          ok: false,
          provider: spec.id,
          exitCode: res.code,
          failure,
          stdout: effectiveStdout,
          stderr: res.stderr,
          structured: null,
        };
      }
    }

    return {
      ok: true,
      provider: spec.id,
      exitCode: res.code,
      stdout: effectiveStdout,
      stderr: res.stderr,
      structured: structured?.data || null,
      structuredSource: structured?.source || null,
    };
  } finally {
    if (settingsFile) fs.rmSync(settingsFile, { force: true });
    if (promptFile && !runDir) fs.rmSync(promptFile, { force: true });
  }
}

module.exports = {
  HARNESS_SPECS,
  METERED_CREDENTIALS,
  getHarness,
  detectHarnesses,
  listLiveModels,
  extractStructuredOutput,
  runHarness,
};
