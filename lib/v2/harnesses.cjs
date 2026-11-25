"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { claudeSettings, openCodeConfig, ensureAntigravityGuard, isPurchaseCommand } = require("../no-purchase.cjs");
const { buildSpawnPlan, stopProcessTree, ownGroup, olderThan, underTest, getAntigravityFallbackPaths } = require("../harness-registry.cjs");
const { locateBinary } = require("../agent-auth.cjs");
const { readClaudeEvent, readCodexEvent, plainLine } = require("../activity.cjs");
const { classifyProviderFailure } = require("./quota.cjs");
const { parseModelListing } = require("./model-catalog.cjs");

/**
 * Unified 4-CLI Terminal Harness Adapter Layer (Claude Code, Codex, Antigravity/Gemini, OpenCode).
 *
 * Key upgrades over v1:
 * - Passes model + reasoning effort flags uniformly (Claude --effort, Codex model_reasoning_effort, etc.)
 * - Antigravity covers Gemini models cleanly alongside Claude Code, Codex, and free OpenCode
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
const GOOGLE_ALTERNATE_AUTH = new Set(["AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS"]);

function subscriptionEnvironment(provider) {
  return Object.fromEntries(Object.keys(process.env)
    .filter(name => METERED_CREDENTIALS.includes(name.toUpperCase())
      || (provider === "antigravity" && GOOGLE_ALTERNATE_AUTH.has(name.toUpperCase())))
    .map(name => [name, undefined]));
}

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
    stream: "antigravity",
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
        "--input-format", "stream-json",
        "--output-format", "stream-json",
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

async function listLiveModels(providerId, { detect = null, spawnFn = spawn, timeoutMs = 15000 } = {}) {
  const spec = getHarness(providerId);
  if (!spec?.listModelsArgs) return null;
  if (underTest() && spawnFn === spawn) return [];
  const workerPath = detect
    ? (await detect()).find(h => h.id === spec.id)?.workerPath
    : locateBinary(spec.workerBinaries);
  if (!workerPath) return [];
  const plan = buildSpawnPlan(workerPath, spec.listModelsArgs);
  const ran = await runSubprocess(plan, {
    cwd: os.tmpdir(), stdin: "", env: subscriptionEnvironment(spec.id), timeoutMs, spawnFn,
  });
  if (ran.code !== 0) return [];
  return parseModelListing(spec.id, ran.stdout);
}

/**
 * Extracts structured stage output reliably without breaking on trailing prose.
 * Order:
 *   1. Designated JSON file written by the agent (stage-result.json)
 *   2. Native structured response from the CLI
 *   3. Last AIOS-RESULT line, fenced JSON block, or complete JSON response
 */
function extractStructuredOutput({ resultFile = null, stdout = "", structuredOutput = null } = {}) {
  if (resultFile && fs.existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
        return { source: "file", data: parsed };
      }
    } catch { /* fall through to stdout parsing */ }
  }

  if (structuredOutput && typeof structuredOutput === "object" && typeof structuredOutput.status === "string") {
    return { source: "stream", data: structuredOutput };
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

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
      return { source: "stdout", data: parsed };
    }
  } catch { /* no complete JSON result */ }
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
      else {
        if (onLine) {
          for (const [key, tail] of Object.entries(tails)) {
            if (tail) {
              try { onLine(key, tail); } catch { /* ignore UI listener errors */ }
            }
          }
        }
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function readAntigravityEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (event?.event === "result" && event.result) return { terminalResult: event.result };
  if (event?.event !== "step_update") return null;
  const step = event.step_update;
  if (step?.state !== "ACTIVE" && step?.state !== "DONE") return null;
  if (step.step_type === "agent_response") return { activity: "Thinking it through" };
  if (step.step_type !== "tool") return null;
  const tool = step.tool_name || step.tool_info?.name;
  const actions = {
    run_command: "Running a command",
    read_file: "Reading a file",
    write_file: "Writing a file",
    edit_file: "Editing a file",
    search_web: "Looking something up",
  };
  return { activity: Object.hasOwn(actions, tool) ? actions[tool] : "Using a tool" };
}

const STREAM_READERS = { claude: readClaudeEvent, codex: readCodexEvent, antigravity: readAntigravityEvent };

/**
 * Executes a single harness run with unified safety fences, effort flags,
 * structured output extraction, and multi-provider failure classification.
 */
async function runHarness({
  provider,
  prompt,
  cwd,
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
  const agyStream = spec.id === "antigravity";
  const inputPrompt = agyStream && mode === "read" && resultFile
    ? prompt + "\nFor this read-only stage, return the AIOS-RESULT line in your final response. Do not write a file or run a command to deliver the result."
    : prompt;
  const stdin = agyStream ? JSON.stringify({ event: "user", message: { content: inputPrompt } }) + "\n" : inputPrompt;

  try {
    if (spec.settings) {
      settingsFile = path.join(os.tmpdir(), `aios-v2-settings-${crypto.randomUUID()}.json`);
      fs.writeFileSync(settingsFile, JSON.stringify(spec.settings({ mode, allowConnectors })), { encoding: "utf8", flag: "wx" });
    }
    const args = spec.buildArgs({ mode, model, effort, cwd, stream: streaming, settingsFile, guarded, allowNetwork });
    const plan = buildSpawnPlan(found.workerPath, args);

    const env = {
      ...(spec.env || {}),
      ...(guarded && spec.guardedEnv ? spec.guardedEnv : {}),
      ...(subscriptionOnly ? subscriptionEnvironment(spec.id) : {}),
    };

    let finalAnswer = null;
    let terminalResult = null;
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
          if (ev?.terminalResult) terminalResult = ev.terminalResult;
          if (ev?.result !== undefined) finalAnswer = ev.result;
          if (ev?.text) streamTexts.push(ev.text);
          if (ev?.activity) onActivity(ev.activity);
        } else if (!streaming) {
          const words = plainLine(line);
          if (words) onActivity(words);
        }
      },
    });

    const effectiveStdout = agyStream ? (terminalResult?.response || "")
      : streaming ? (finalAnswer || streamTexts.at(-1) || res.stdout) : res.stdout;
    const combined = [terminalResult?.error, effectiveStdout, res.stderr].filter(Boolean).join("\n").trim();
    const terminalFailed = Boolean(agyStream && terminalResult && terminalResult.status !== "SUCCESS");
    const expectsResult = Boolean(resultFile) || (agyStream && !terminalResult);
    const structured = res.code === 0 && !terminalFailed && (!agyStream || terminalResult)
      ? extractStructuredOutput({ resultFile, stdout: effectiveStdout, structuredOutput: terminalResult?.structured_output }) : null;

    // Classify quota/auth errors even on clean exit when no valid structured result was emitted.
    if (res.code !== 0 || terminalFailed || (!structured && (expectsResult || combined.length < 1000))) {
      const exitCode = terminalFailed ? (res.code || 1) : (res.code ?? 1);
      const failure = classifyProviderFailure(spec.id, combined, { exitCode, expectsResult });
      if (failure.kind !== "unknown") {
        return {
          ok: false,
          provider: spec.id,
          exitCode,
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
