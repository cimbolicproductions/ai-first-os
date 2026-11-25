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
  "console.anthropic.com",
  "auth.openai.com",
  "chatgpt.com",
  "accounts.google.com",
  "aistudio.google.com",
  "cursor.com",
  "authenticator.cursor.sh",
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
    checkArgs: ["auth", "status"],
    pressEnter: true,
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
    parsePrompt(out) {
      const link = /https:\/\/(?:claude\.ai|console\.anthropic\.com)\/[^\s"'<>]+/i.exec(out)?.[0] || null;
      return { link, code: null };
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
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    kind: "cli-oauth",
    binaries: isWin ? ["gemini.exe", "gemini.cmd"] : ["gemini"],
    loginArgs: [],
    checkArgs: ["--version"],
    parsePrompt(out) {
      const link = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/i.exec(out)?.[0] || null;
      return { link, code: null };
    },
  },
  cursor: {
    id: "cursor",
    label: "Cursor CLI",
    kind: "cli-oauth",
    binaries: isWin ? ["cursor-agent.cmd", "cursor-agent.exe", "agent.cmd", "agent.exe"] : ["cursor-agent", "agent"],
    loginArgs: ["login"],
    checkArgs: ["status"],
    parsePrompt(out) {
      const link = /https:\/\/(?:cursor\.com|authenticator\.cursor\.sh)\/[^\s"'<>]+/i.exec(out)?.[0] || null;
      return { link, code: null };
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
} = {}) {
  const active = new Map(); // service -> { approvalId, oneTimeToken, promise }

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

  /**
   * Starts a 1-link sign-in flow for an expired CLI or unconnected service.
   * Returns the created approval card containing the clickable link (and code if device-auth).
   */
  async function requestAuth({ taskId = null, service, reason = null }) {
    const spec = resolveServiceSpec(service);
    if (!spec) throw Object.assign(new Error(`Unknown service "${service}"`), { code: "UNKNOWN_SERVICE" });

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
      connected: spec.secretName ? vault.has(spec.secretName) : null,
      secretName: spec.secretName || null,
      dashboardUrl: spec.dashboardUrl || null,
    }));
  }

  return {
    vault,
    requestAuth,
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
