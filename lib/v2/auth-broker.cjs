"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { locateBinary } = require("../agent-auth.cjs");
const { buildSpawnPlan, stopProcessTree, ownGroup, underTest } = require("../harness-registry.cjs");
const { readSecret, storeSecret } = require("../keyring.cjs");

/**
 * Unified One-Link Auth & Credential Broker.
 *
 * Replaces 5 fragmented auth mechanisms (stub catalog connects, desktop-only
 * cmd.exe popups, hardcoded GitHub/Vercel-only scripts, manual key copy-paste).
 *
 * Every expired CLI or unconnected service produces ONE clickable sign-in link
 * surfaced on Desktop, Phone, Muse, and GrokBot. Once approved or submitted,
 * credentials are stored in the OS Keyring (with fast in-memory daemon caching)
 * and the exact paused task auto-resumes.
 */

const AUTH_TIMEOUT_MS = 15 * 60 * 1000;
const ALLOWED_AUTH_HOSTS = new Set([
  "github.com",
  "vercel.com",
  "claude.ai",
  "claude.com",
  "platform.claude.com",
  "console.anthropic.com",
  "auth.openai.com",
  "chatgpt.com",
  "accounts.google.com",
  "aistudio.google.com",
  "dashboard.stripe.com",
  "supabase.com",
  "api.supabase.com",
]);

const isWin = process.platform === "win32";

const SERVICE_REGISTRY = Object.freeze({
  github: {
    id: "github",
    label: "GitHub",
    kind: "cli-device",
    binaries: isWin ? ["gh.exe", "gh.cmd"] : ["gh"],
    loginArgs: ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"],
    checkArgs: ["auth", "status", "--hostname", "github.com", "--active"],
    parsePrompt(out) {
      const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(out)?.[1] || null;
      return { link: code ? "https://github.com/login/device" : null, code };
    },
  },
  vercel: {
    id: "vercel",
    label: "Vercel",
    kind: "cli-device",
    binaries: isWin ? ["vercel.cmd", "vercel.exe"] : ["vercel"],
    loginArgs: ["login"],
    checkArgs: ["whoami"],
    pressEnter: false,
    parsePrompt(out) {
      const link = /https:\/\/vercel\.com\/[^\s"'<>]*device[^\s"'<>]*/i.exec(out)?.[0] || null;
      return { link, code: null };
    },
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    kind: "cli-oauth",
    binaries: isWin ? ["claude.exe", "claude.cmd"] : ["claude"],
    loginArgs: ["auth", "login"],
    checkArgs: ["auth", "status"],
    parseManualLink(out) {
      const urls = out.matchAll(/https:\/\/[^\s"'<>\x00-\x1f]+/g);
      for (const [raw] of urls) {
        const safe = sanitizeAuthLink(raw);
        if (!safe) continue;
        const url = new URL(safe);
        if (!["https://claude.com/cai/oauth/authorize", "https://claude.ai/oauth/authorize",
          "https://claude.ai/cai/oauth/authorize", "https://platform.claude.com/oauth/authorize",
          "https://console.anthropic.com/oauth/authorize"].includes(url.origin + url.pathname)) continue;
        if (!["https://platform.claude.com/oauth/code/callback",
          "https://console.anthropic.com/oauth/code/callback"].includes(url.searchParams.get("redirect_uri"))) continue;
        return safe;
      }
      return null;
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    kind: "cli-oauth",
    binaries: isWin ? ["codex.exe", "codex.cmd"] : ["codex"],
    loginArgs: ["login", "--device-auth"],
    checkArgs: ["login", "status"],
    parsePrompt(out) {
      const link = /https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[^\s"'<>]+/i.exec(out)?.[0] || null;
      const code = /(?:code|enter):\s*([A-Z0-9]{4,5}-[A-Z0-9]{4,5})/i.exec(out)?.[1] || null;
      return { link, code };
    },
  },
  stripe: {
    id: "stripe",
    label: "Stripe",
    kind: "token-capture",
    secretName: "AIOS_STRIPE_RESTRICTED_KEY",
    dashboardUrl: "https://dashboard.stripe.com/apikeys",
    placeholder: "rk_live_... or rk_test_...",
  },
  supabase: {
    id: "supabase",
    label: "Supabase",
    kind: "token-capture",
    secretName: "AIOS_SUPABASE_TOKEN",
    dashboardUrl: "https://supabase.com/dashboard/account/tokens",
    placeholder: "sbp_...",
  },
});

function sanitizeAuthLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && ALLOWED_AUTH_HOSTS.has(parsed.hostname)) return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

/** Fast cached OS keyring layer (avoids repeated PowerShell C# Add-Type compilation). */
function createSecretVault({ read = readSecret, store = storeSecret } = {}) {
  const cache = new Map();
  return {
    get(secretName) {
      if (cache.has(secretName)) return cache.get(secretName);
      const val = read(secretName);
      if (val !== null && val !== undefined) cache.set(secretName, val);
      return val;
    },
    set(secretName, value) {
      store(secretName, value);
      cache.set(secretName, value);
      return true;
    },
    has(secretName) {
      const val = this.get(secretName);
      return typeof val === "string" && val.length > 0;
    },
    clearCache() {
      cache.clear();
    },
  };
}

function createAuthBroker({
  store,
  vault = createSecretVault(),
  getBaseUrl = () => "http://127.0.0.1:4318",
  onAuthResolved = () => {},
  spawnFn = spawn,
  locate = binaries => locateBinary(binaries),
  timeoutMs = AUTH_TIMEOUT_MS,
  linkTimeoutMs = 15000,
  codeTimeoutMs = 30000,
} = {}) {
  const active = new Map(); // service -> { approvalId, oneTimeToken, promise }
  const githubTaskIds = new Set();
  let githubConnected = null;
  // Device codes cannot be redeemed after their original CLI process has stopped.
  for (const approval of store.listOpenApprovals({ kind: "auth" })) {
    if (approval.service !== "github") continue;
    if (approval.taskId) githubTaskIds.add(approval.taskId);
    store.resolveAuthApproval(approval.id, "expired");
  }

  function resolveServiceSpec(serviceId) {
    const key = String(serviceId || "").toLowerCase().trim();
    if (SERVICE_REGISTRY[key]) return SERVICE_REGISTRY[key];
    // Generic token-capture fallback for any custom MCP or REST service.
    const clean = key.replace(/[^a-z0-9_-]/g, "");
    if (!clean) return null;
    const secretName = `AIOS_${clean.toUpperCase().replace(/-/g, "_")}_KEY`.slice(0, 60);
    return {
      id: clean,
      label: clean.charAt(0).toUpperCase() + clean.slice(1),
      kind: "token-capture",
      secretName,
      dashboardUrl: null,
      placeholder: "Paste token or API key",
    };
  }

  function finishAuth({ service, approvalId, taskId, ok, outcomeValue = "signed_in" }) {
    active.delete(service);
    if (ok) {
      store.resolveAuthApproval(approvalId, outcomeValue);
      store.clearQuota(service);
      if (taskId) {
        store.addThreadMessage({
          taskId,
          role: "system",
          kind: "status",
          content: `Connected to ${resolveServiceSpec(service)?.label || service}. Resuming automatically.`,
        });
      }
      try { onAuthResolved({ taskId, service, approvalId }); } catch { /* ignore */ }
    } else {
      store.resolveAuthApproval(approvalId, "failed");
    }
  }

  function authError(message, code) {
    return Object.assign(new Error(message), { code });
  }

  function requestGitHubAuth(spec, taskId, replaceApprovalId) {
    if (taskId) githubTaskIds.add(taskId);
    const current = active.get(spec.id);
    if (current) {
      if (!current.card) return current.ready;
      const open = store.listOpenApprovals({ kind: "auth" }).some(card => card.id === current.card.id);
      if (open && current.card.id !== replaceApprovalId) return current.ready;
      current.stop();
    }

    const binary = locate(spec.binaries);
    if (!binary) throw authError("GitHub CLI is unavailable on the host computer.", "AUTH_CLI_MISSING");
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const session = { ready, card: null, stop: null };
    active.set(spec.id, session);

    let child;
    let timer;
    let finished = false;
    function complete({ error, kill = false, outcome = "failed", alreadyConnected = false } = {}) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      active.delete(spec.id);
      if (kill && child) stopProcessTree(child);
      if (session.card) store.resolveAuthApproval(session.card.id, error ? outcome : "signed_in");
      if (error) {
        rejectReady(error);
        return;
      }
      githubConnected = true;
      store.clearQuota(spec.id);
      let resumed = false;
      for (const linkedTaskId of githubTaskIds) {
        if (store.getTask(linkedTaskId)?.stage !== "waiting_auth") continue;
        store.addThreadMessage({ taskId: linkedTaskId, role: "system", kind: "status", content: "Connected to GitHub. Resuming automatically." });
        try { onAuthResolved({ taskId: linkedTaskId, service: spec.id, approvalId: session.card?.id }); } catch { /* ignore */ }
        resumed = true;
      }
      if (!resumed) {
        try { onAuthResolved({ taskId: null, service: spec.id, approvalId: session.card?.id }); } catch { /* ignore */ }
      }
      githubTaskIds.clear();
      if (alreadyConnected) resolveReady({ alreadyConnected: true, service: spec.id });
    }
    session.stop = () => complete({
      error: authError("This GitHub sign-in is closed. Request a new code to continue.", "AUTH_NOT_OPEN"),
      kill: true,
      outcome: "expired",
    });

    function launch(args, stdio) {
      const plan = buildSpawnPlan(binary, args);
      return spawnFn(plan.file, plan.args, {
        windowsHide: true, stdio,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", BROWSER: "echo" },
        ...ownGroup(),
        ...plan.options,
      });
    }

    function startLogin() {
      githubConnected = false;
      const startedAt = Date.now();
      const lifetime = Math.min(timeoutMs, AUTH_TIMEOUT_MS);
      child = launch(spec.loginArgs, ["pipe", "pipe", "pipe"]);
      const fail = (message, code) => complete({ error: authError(message, code), kill: true });
      timer = setTimeout(() => fail("GitHub CLI didn’t return a sign-in code. Try again.", "AUTH_LINK_MISSING"), Math.min(linkTimeoutMs, lifetime));
      let output = "";
      const onData = chunk => {
        if (finished || session.card) return;
        output = (output + chunk).slice(-8192);
        const { link, code } = spec.parsePrompt(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
        if (!link || !code) return;
        const remaining = lifetime - (Date.now() - startedAt);
        if (remaining <= 0) {
          session.stop();
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(session.stop, remaining);
        session.card = store.createApproval({
          taskId: taskId || githubTaskIds.values().next().value || null,
          kind: "auth",
          title: "Sign in to GitHub",
          prompt: "Enter the code below on GitHub. If GitHub says it expired, get a new code here.",
          choices: [{ label: "Cancel", value: "cancel" }],
          link,
          linkLabel: "Open GitHub sign-in",
          code,
          service: spec.id,
          meta: { kind: spec.kind },
          ttlMs: remaining,
        });
        child.stdin?.write("\n");
        resolveReady(session.card);
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", onData);
      }
      child.stdin?.on("error", () => {});
      child.on("error", () => fail("Couldn’t start GitHub sign-in on the computer.", "AUTH_CLI_START"));
      child.on("close", code => {
        if (code === 0 && session.card) complete();
        else complete({ error: authError("GitHub sign-in ended. Request a new code to try again.", "AUTH_CLI_CLOSED") });
      });
    }

    try {
      child = launch(spec.checkArgs, "ignore");
      timer = setTimeout(() => complete({
        error: authError("Couldn’t check the GitHub connection in time. Try again.", "AUTH_CHECK_TIMEOUT"),
        kill: true,
      }), linkTimeoutMs);
      child.on("error", () => complete({ error: authError("Couldn’t start the GitHub connection check.", "AUTH_CLI_START") }));
      child.on("close", code => {
        if (finished) return;
        clearTimeout(timer);
        if (code === 0) complete({ alreadyConnected: true });
        else if (code === 1) {
          try { startLogin(); } catch (error) { complete({ error }); }
        } else {
          complete({ error: authError("GitHub CLI could not check the connection. Try again.", "AUTH_CHECK_FAILED") });
        }
      });
    } catch (error) {
      complete({ error });
    }
    return ready;
  }

  function requestClaudeAuth(spec, taskId) {
    const current = active.get(spec.id);
    if (current?.ready && (!current.card || !store.getApproval(current.card.id)?.answeredAt)) {
      if (taskId) current.taskIds.add(taskId);
      return current.ready;
    }
    current?.stop?.();

    const binary = locate(spec.binaries);
    if (!binary) throw authError("Claude Code is unavailable on the host computer. Install it and try again.", "AUTH_CLI_MISSING");
    const plan = buildSpawnPlan(binary, spec.loginArgs);
    const taskIds = new Set(taskId ? [taskId] : []);
    for (const previous of store.listOpenApprovals({ kind: "auth" })) {
      if (previous.service !== spec.id) continue;
      if (previous.taskId) taskIds.add(previous.taskId);
      store.resolveAuthApproval(previous.id, "expired");
    }

    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const session = { ready, taskIds, card: null, submit: null, stop: null };
    const child = spawnFn(plan.file, plan.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", BROWSER: "echo" },
      ...ownGroup(),
      ...plan.options,
    });
    active.set(spec.id, session);

    let closed = false;
    let output = "";
    let codeTimer;
    function complete(error, { kill = false } = {}) {
      if (closed) return;
      closed = true;
      clearTimeout(linkTimer);
      clearTimeout(sessionTimer);
      clearTimeout(codeTimer);
      active.delete(spec.id);
      if (kill) stopProcessTree(child);
      if (session.card) {
        store.resolveAuthApproval(session.card.id, error ? "failed" : "signed_in");
      } else {
        rejectReady(error || authError("Claude Code exited before providing a sign-in link. Try again.", "AUTH_LINK_MISSING"));
      }
      if (error) {
        session.submit?.reject(error);
        return;
      }
      store.clearQuota(spec.id);
      for (const linkedTaskId of taskIds) {
        const task = store.getTask(linkedTaskId);
        if (task?.stage !== "waiting_auth") continue;
        store.addThreadMessage({ taskId: linkedTaskId, role: "system", kind: "status", content: "Connected to Claude Code. Resuming automatically." });
        onAuthResolved({ taskId: linkedTaskId, service: spec.id, approvalId: session.card?.id });
      }
      if (!taskIds.size) onAuthResolved({ taskId: null, service: spec.id, approvalId: session.card?.id });
      session.submit?.resolve({ ok: true, service: spec.id });
    }

    const linkTimer = setTimeout(() => {
      complete(authError("Claude Code didn’t return a phone sign-in link. Try again or sign in on the computer.", "AUTH_LINK_MISSING"), { kill: true });
    }, linkTimeoutMs);
    const sessionTimer = setTimeout(() => {
      complete(authError("This Claude sign-in expired. Request a new link and try again.", "AUTH_SESSION_EXPIRED"), { kill: true });
    }, timeoutMs);
    linkTimer.unref?.();
    sessionTimer.unref?.();
    session.stop = () => complete(authError("This Claude sign-in was closed. Request a new link to continue.", "AUTH_NOT_OPEN"), { kill: true });
    session.sendCode = code => new Promise((resolve, reject) => {
      session.submit = { resolve, reject };
      codeTimer = setTimeout(() => {
        complete(authError("Claude Code didn’t confirm the code in time. Request a new sign-in link and try again.", "AUTH_CODE_TIMEOUT"), { kill: true });
      }, codeTimeoutMs);
      codeTimer.unref?.();
      child.stdin.write(code + "\n", error => {
        if (error) complete(authError("Claude Code couldn’t receive the code. Request a new sign-in link.", "AUTH_CODE_WRITE"), { kill: true });
      });
    });

    function onData(chunk) {
      if (closed || session.card) return;
      output = (output + chunk).slice(-16384);
      // The URL and the terminal input prompt can arrive in separate chunks.
      if (!output.includes("Paste code here")) return;
      const link = spec.parseManualLink(output);
      if (!link) return;
      clearTimeout(linkTimer);
      output = "";
      session.card = store.createApproval({
        taskId: taskIds.values().next().value ?? null,
        kind: "auth",
        title: "Sign in to Claude Code",
        prompt: "Open Claude sign-in. After authorizing, copy the code Claude shows you and paste it here.",
        choices: [{ label: "Cancel", value: "cancel" }],
        link,
        linkLabel: "Open Claude sign-in",
        service: spec.id,
        meta: { kind: spec.kind, acceptsCode: true },
        ttlMs: timeoutMs,
      });
      resolveReady(session.card);
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", onData);
    }
    child.stdin?.on("error", () => {});
    child.on("error", () => complete(authError("Couldn’t start Claude Code sign-in on the computer. Try again.", "AUTH_CLI_START")));
    child.on("close", code => complete(code === 0 ? null : authError(
      session.submit ? "Claude Code didn’t accept the code. Request a new sign-in link and try again."
        : "Claude Code closed before sign-in finished. Request a new sign-in link and try again.",
      session.submit ? "AUTH_CODE_REJECTED" : "AUTH_CLI_CLOSED"
    )));
    return ready;
  }

  /**
   * Starts a 1-link sign-in flow for an expired CLI or unconnected service.
   * Returns the created approval card containing the clickable link (and code if device-auth).
   */
  async function requestAuth({ taskId = null, service, reason = null, replaceApprovalId = null }) {
    const spec = resolveServiceSpec(service);
    if (!spec) throw Object.assign(new Error(`Unknown service "${service}"`), { code: "UNKNOWN_SERVICE" });

    if (spec.id === "claude" && !(underTest() && spawnFn === spawn)) {
      return requestClaudeAuth(spec, taskId);
    }
    if (spec.id === "github" && !(underTest() && spawnFn === spawn)) {
      return requestGitHubAuth(spec, taskId, replaceApprovalId);
    }

    // Avoid duplicating an already-open auth card for the same service.
    const open = store.listOpenApprovals({ kind: "auth" }).find(a => a.service === spec.id);
    if (open) return open;

    // Token-capture flow: generates a one-time secure form link served by the OS daemon.
    if (spec.kind === "token-capture") {
      if (vault.has(spec.secretName)) {
        if (taskId) onAuthResolved({ taskId, service: spec.id, alreadyConnected: true });
        return { alreadyConnected: true, service: spec.id };
      }
      const oneTimeToken = crypto.randomBytes(24).toString("base64url");
      const baseUrl = String(getBaseUrl() || "http://127.0.0.1:4318").replace(/\/+$/, "");
      const approval = store.createApproval({
        taskId,
        kind: "auth",
        title: `Connect ${spec.label}`,
        prompt: `${reason ? reason + " " : ""}Open the secure sign-in link to connect ${spec.label}. Your key is stored directly in your OS keyring and this task resumes automatically.`,
        choices: [{ label: "Cancel", value: "cancel" }],
        link: `${baseUrl}/auth?service=${encodeURIComponent(spec.id)}`,
        linkLabel: `Connect ${spec.label}`,
        service: spec.id,
        meta: {
          kind: "token-capture",
          secretName: spec.secretName,
          dashboardUrl: spec.dashboardUrl,
          placeholder: spec.placeholder,
          tokenHash: crypto.createHash("sha256").update(oneTimeToken).digest("hex"),
        },
      });
      active.set(spec.id, { approvalId: approval.id, taskId, oneTimeToken, spec });
      return { ...approval, captureToken: oneTimeToken };
    }

    // CLI device-code / OAuth link capture flow (phone-clickable, zero desktop cmd.exe popups).
    const binary = locate(spec.binaries);
    if (!binary || (underTest() && spawnFn === spawn)) {
      const approval = store.createApproval({
        taskId,
        kind: "auth",
        title: `Sign in to ${spec.label}`,
        prompt: !binary
          ? `${spec.label} CLI is not installed on this computer. Install it, then resume.`
          : `${reason || `${spec.label} needs sign-in.`} Complete sign-in and press Resume.`,
        choices: [{ label: "I signed in", value: "signed_in" }, { label: "Cancel", value: "cancel" }],
        service: spec.id,
        meta: { kind: spec.kind, binaryFound: Boolean(binary) },
      });
      active.set(spec.id, { approvalId: approval.id, taskId, spec });
      return approval;
    }

    // Launch CLI auth headless, capture the HTTPS sign-in URL + optional device code.
    return new Promise(resolve => {
      let plan;
      try { plan = buildSpawnPlan(binary, spec.loginArgs); } catch {
        const fallback = store.createApproval({
          taskId, kind: "auth", title: `Sign in to ${spec.label}`,
          prompt: `Could not launch ${spec.label} sign-in automatically.`,
          choices: [{ label: "I signed in", value: "signed_in" }], service: spec.id,
        });
        return resolve(fallback);
      }

      const child = spawnFn(plan.file, plan.args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", BROWSER: "echo" },
        ...ownGroup(),
        ...plan.options,
      });

      let output = "";
      let card = null;
      let resolvedInitial = false;

      const emitCard = ({ link, code }) => {
        const safe = link ? sanitizeAuthLink(link) : null;
        card = store.createApproval({
          taskId,
          kind: "auth",
          title: `Sign in to ${spec.label}`,
          prompt: code
            ? `Open the ${spec.label} sign-in link and enter code ${code}. Your task resumes automatically once approved.`
            : `Open the ${spec.label} sign-in link to authenticate. Your task resumes automatically once approved.`,
          choices: [{ label: "Cancel", value: "cancel" }],
          link: safe,
          linkLabel: `Sign in to ${spec.label}`,
          code: code || null,
          service: spec.id,
          meta: { kind: spec.kind },
        });
        active.set(spec.id, { approvalId: card.id, taskId, spec, child });
        if (!resolvedInitial) {
          resolvedInitial = true;
          resolve(card);
        }
      };

      const initialTimer = setTimeout(() => {
        if (!resolvedInitial) {
          emitCard({ link: null, code: null });
        }
      }, 4000);

      const maxTimer = setTimeout(() => {
        stopProcessTree(child);
        if (card) finishAuth({ service: spec.id, approvalId: card.id, taskId, ok: false });
      }, timeoutMs);
      maxTimer.unref?.();

      const onData = chunk => {
        output += chunk;
        if (card) return;
        const parsed = spec.parsePrompt(output);
        if (parsed.link || parsed.code) {
          clearTimeout(initialTimer);
          if (spec.pressEnter) {
            try { child.stdin.write("\n"); } catch { /* ignore */ }
          }
          emitCard(parsed);
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.stdin?.on("error", () => {});

      child.on("close", code => {
        clearTimeout(initialTimer);
        clearTimeout(maxTimer);
        if (!resolvedInitial) {
          emitCard({ link: null, code: null });
        }
        if (card) {
          finishAuth({ service: spec.id, approvalId: card.id, taskId, ok: code === 0 });
        }
      });
    });
  }

  function submitCode({ approvalId, code }) {
    const parts = typeof code === "string" && code.length <= 4096 && /^[\x21-\x7e]+$/.test(code) && !/[\r\n]/.test(code)
      ? code.split("#") : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw authError("Paste the full authorization code shown by Claude.", "AUTH_CODE_INVALID");
    }
    const session = active.get("claude");
    if (!session?.card || session.card.id !== approvalId || store.getApproval(approvalId)?.answeredAt) {
      throw authError("This Claude sign-in is no longer active. Request a new link.", "AUTH_NOT_OPEN");
    }
    const expectedState = new URL(session.card.link).searchParams.get("state");
    if (!expectedState || expectedState !== parts[1]) {
      throw authError("Use the code from the current Claude sign-in link.", "AUTH_CODE_INVALID");
    }
    if (session.submit) throw authError("Claude Code is already checking a code for this link.", "AUTH_CODE_PENDING");
    return session.sendCode(code);
  }

  function cancelAuth(approvalId) {
    const session = active.get(store.getApproval(approvalId)?.service);
    if (session?.card?.id === approvalId) session.stop();
  }

  /** Receives a secret submitted through the secure /api/auth/submit endpoint, saves to keyring, and auto-resumes. */
  function submitSecret({ approvalId, secretValue, service = null }) {
    const clean = String(secretValue || "").trim();
    if (!clean || clean.length > 4096) {
      throw Object.assign(new Error("Enter a valid key or token."), { code: "INVALID_SECRET" });
    }
    const approval = approvalId ? store.getApproval(approvalId) : store.listOpenApprovals({ kind: "auth" }).find(a => a.service === service);
    if (!approval || approval.kind !== "auth" || approval.answeredAt) {
      throw Object.assign(new Error("That sign-in request is no longer open."), { code: "AUTH_NOT_OPEN" });
    }
    const secretName = approval.meta?.secretName || resolveServiceSpec(approval.service)?.secretName;
    if (!secretName) throw Object.assign(new Error("This provider does not accept manual secrets."), { code: "UNSUPPORTED_SECRET" });
    vault.set(secretName, clean);
    finishAuth({ service: approval.service, approvalId: approval.id, taskId: approval.taskId, ok: true });
    return { ok: true, service: approval.service, taskId: approval.taskId, secretName };
  }

  function listServiceStatuses() {
    return Object.values(SERVICE_REGISTRY).map(spec => ({
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      connected: spec.id === "github" ? githubConnected : spec.secretName ? vault.has(spec.secretName) : null,
      secretName: spec.secretName || null,
      dashboardUrl: spec.dashboardUrl || null,
    }));
  }

  return {
    vault,
    requestAuth,
    submitCode,
    cancelAuth,
    stop() {
      active.get("claude")?.stop?.();
      active.get("github")?.stop?.();
    },
    submitSecret,
    listServiceStatuses,
    resolveServiceSpec,
  };
}

module.exports = {
  SERVICE_REGISTRY,
  sanitizeAuthLink,
  createSecretVault,
  createAuthBroker,
};
