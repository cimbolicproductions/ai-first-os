"use strict";

const { spawn } = require("node:child_process");
const { locateBinary } = require("./agent-auth.cjs");
const { buildSpawnPlan, stopProcessTree, ownGroup, underTest } = require("./harness-registry.cjs");

/**
 * Connecting a service, done inside the box. The service's own sign-in runs in
 * the background. The page to approve it opens in the browser, and the same
 * link (with a code, if the service uses one) is shown in the chat and on the
 * phone, so it can be approved from either. When the sign-in completes, the
 * work that was waiting carries on by itself. Nobody sees a terminal.
 */
const isWin = process.platform === "win32";
const SERVICES = Object.freeze({
  vercel: {
    label: "Vercel",
    binaries: isWin ? ["vercel.cmd", "vercel.exe"] : ["vercel"],
    args: ["login"],
    check: ["whoami"],
    // Vercel prints a page that already carries the code, and waits on its own.
    find: out => ({ link: /https:\/\/vercel\.com\/[^\s"'<>]*device[^\s"'<>]*/i.exec(out)?.[0] || null, code: null }),
    openLink: true,
    pressEnter: false,
    get: "https://vercel.com/docs/cli",
  },
  github: {
    label: "GitHub",
    binaries: isWin ? ["gh.exe", "gh.cmd"] : ["gh"],
    args: ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"],
    check: ["auth", "status"],
    // GitHub prints a one-time code and waits for Enter before it opens its page and listens.
    find: out => {
      const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(out)?.[1] || null;
      return { link: code ? "https://github.com/login/device" : null, code };
    },
    openLink: false,
    pressEnter: true,
    get: "https://cli.github.com",
  },
});
const LINK_HOSTS = new Set(["vercel.com", "github.com", "cli.github.com"]);
const EXPIRES_MS = 15 * 60 * 1000;
const active = new Map();

/** Only these pages are ever offered as a sign-in link. */
function safeLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && LINK_HOSTS.has(parsed.hostname) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function openInBrowser(url, { platform = process.platform, spawnFn = spawn, env = process.env } = {}) {
  const link = safeLink(url);
  if (!link) return false;
  if (underTest() && spawnFn === spawn) return false;
  const quiet = { detached: true, stdio: "ignore", windowsHide: true };
  const child = platform === "win32"
    ? spawnFn(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `start "" "${link}"`], { ...quiet, windowsVerbatimArguments: true })
    : spawnFn(platform === "darwin" ? "open" : "xdg-open", [link], quiet);
  child?.on?.("error", () => {});
  child?.unref?.();
  return true;
}

function runCheck(file, args, spawnFn) {
  return new Promise(resolve => {
    let plan;
    try { plan = buildSpawnPlan(file, args); } catch { return resolve(false); }
    const child = spawnFn(plan.file, plan.args, { windowsHide: true, stdio: ["ignore", "ignore", "ignore"], ...plan.options });
    child.on("error", () => resolve(false));
    child.on("close", code => resolve(code === 0));
  });
}

/**
 * Starts one service's sign-in. onPrompt gets { link, code } as soon as the
 * service says where to approve. The returned promise settles with
 * { ok: true } once signed in, or { ok: false, reason } when it was not.
 */
function startConnect(service, {
  onPrompt = () => {},
  spawnFn = spawn,
  openUrl = openInBrowser,
  locate = binaries => locateBinary(binaries),
  timeoutMs = EXPIRES_MS,
} = {}) {
  const spec = SERVICES[service];
  if (!spec) return Promise.resolve({ ok: false, reason: "unknown" });
  if (active.has(service)) return active.get(service);
  const file = locate(spec.binaries);
  // The tool is not on this computer. The app offers to add it; nothing is opened behind the owner's back.
  if (!file) return Promise.resolve({ ok: false, reason: "missing", get: spec.get });
  // A test never starts a real sign-in, even when it forgets to pass its stand-in.
  if (underTest() && spawnFn === spawn) return Promise.resolve({ ok: false, reason: "failed", refused: true });
  const done = new Promise(resolve => {
    let plan;
    try { plan = buildSpawnPlan(file, spec.args); } catch { return resolve({ ok: false, reason: "failed" }); }
    const child = spawnFn(plan.file, plan.args, {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", BROWSER: process.env.BROWSER },
      ...ownGroup(),
      ...plan.options,
    });
    let output = "";
    let prompted = false;
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // Kept referenced on purpose: a sign-in the owner is approving is a reason to stay up.
    const timer = setTimeout(() => { stopProcessTree(child); finish({ ok: false, reason: "expired" }); }, timeoutMs);
    const read = chunk => {
      output += chunk;
      if (prompted) return;
      const { link, code } = spec.find(output);
      const page = link && safeLink(link);
      if (!page || (spec.pressEnter && !code)) return;
      prompted = true;
      if (spec.openLink) openUrl(page);
      if (spec.pressEnter) child.stdin.write("\n");
      try { onPrompt({ link: page, code }); } catch { /* the prompt is shown best effort */ }
    };
    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.stdin.on?.("error", () => {});
    child.on("error", () => finish({ ok: false, reason: "failed" }));
    child.on("close", async code => {
      if (settled) return;
      // The tool's own word on whether it worked, never the text it printed.
      const signedIn = code === 0 && await runCheck(file, spec.check, spawnFn);
      finish(signedIn ? { ok: true } : { ok: false, reason: prompted ? "not_approved" : "failed" });
    });
  }).finally(() => active.delete(service));
  active.set(service, done);
  return done;
}

module.exports = { startConnect, openInBrowser, safeLink, SERVICES };
