"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { SCHEMA_SQL, sha256Hex } = require("./relay-core.cjs");
const { renderEdgeFunction } = require("./relay-host.cjs");
const { newToken } = require("./cloud-link.cjs");

const API = "https://api.supabase.com";
const PROJECT_NAME = "ai-first-os";
const FUNCTION_SLUG = "aios";
const SECRET_NAMES = Object.freeze({
  home: "AIOS_HOME_TOKEN",
  phone: "AIOS_PHONE_TOKEN",
  publishable: "AIOS_REALTIME_KEY",
  database: "AIOS_DATABASE_PASSWORD",
  vapid: "AIOS_VAPID_KEYS",
});

const DEFAULT_SIGN_IN_PORT = 53682;

function managementClient({ accessToken, api = API, fetchFn = fetch }) {
  return async function call(method, route, { json, form } = {}) {
    const res = await fetchFn(`${api}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : form ? { body: form } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const isProjectLimit = method === "POST" && route === "/v1/projects" && /limit|maximum|free project/i.test(text);
      throw Object.assign(new Error(isProjectLimit ? "Your Supabase account has no room for another free project." : `Setup could not finish (${method} ${route.split("?")[0]} answered ${res.status}).`), {
        code: isProjectLimit ? "PROJECT_LIMIT" : "PROVISION_FAILED",
        status: res.status,
      });
    }
    return text ? JSON.parse(text) : null;
  };
}

/**
 * Creates or reuses the person's own backend behind one sign-in. A free plan
 * proceeds quietly. Anything that could cost money stops at confirmCost, which
 * must answer an explicit true; a missing answer means no.
 */
async function provisionSupabase({
  accessToken,
  api = API,
  fetchFn = fetch,
  storeSecret,
  confirmCost = async () => false,
  regionGroup = "americas",
  pollMs = 3000,
  pollAttempts = 100,
}) {
  const call = managementClient({ accessToken, api, fetchFn });

  const orgs = await call("GET", "/v1/organizations");
  if (!orgs.length) return { ok: false, code: "NO_ORGANIZATION" };
  const slug = orgs[0].slug || orgs[0].id;
  const org = await call("GET", `/v1/organizations/${encodeURIComponent(slug)}`);

  const projects = await call("GET", "/v1/projects");
  let project = projects.find(p => p.name === PROJECT_NAME);

  if (!project) {
    if (org.plan !== "free") {
      const yes = await confirmCost({
        question: "Creating your backend on this Supabase account may add to its bill. Create it?",
        plan: org.plan,
      });
      if (yes !== true) return { ok: false, code: "COST_NOT_APPROVED" };
    }
    const dbPass = crypto.randomBytes(24).toString("base64url");
    project = await call("POST", "/v1/projects", {
      json: {
        name: PROJECT_NAME,
        db_pass: dbPass,
        organization_slug: slug,
        region_selection: { type: "smartGroup", code: regionGroup },
      },
    });
    storeSecret(SECRET_NAMES.database, dbPass);
  }

  const ref = project.ref || project.id;
  for (let i = 0; ; i++) {
    const current = await call("GET", `/v1/projects/${ref}`);
    if (current.status === "ACTIVE_HEALTHY") break;
    if (i >= pollAttempts) return { ok: false, code: "PROJECT_NOT_READY" };
    await new Promise(r => setTimeout(r, pollMs));
  }

  await call("POST", `/v1/projects/${ref}/database/query`, { json: { query: SCHEMA_SQL } });

  const homeToken = newToken();
  const phoneToken = newToken();
  await call("POST", `/v1/projects/${ref}/secrets`, {
    json: [
      { name: "AIOS_HOME_TOKEN_HASH", value: await sha256Hex(homeToken) },
      { name: "AIOS_PHONE_TOKEN_HASH", value: await sha256Hex(phoneToken) },
    ],
  });

  const form = new FormData();
  form.append("metadata", JSON.stringify({ name: FUNCTION_SLUG, entrypoint_path: "index.ts", verify_jwt: false }));
  form.append("file", new Blob([renderEdgeFunction()], { type: "text/plain" }), "index.ts");
  await call("POST", `/v1/projects/${ref}/functions/deploy?slug=${FUNCTION_SLUG}`, { form });

  const keys = await call("GET", `/v1/projects/${ref}/api-keys`);
  const publishable = keys.find(k => k.type === "publishable") || keys.find(k => k.name === "anon");

  storeSecret(SECRET_NAMES.home, homeToken);
  storeSecret(SECRET_NAMES.phone, phoneToken);
  if (publishable?.api_key) storeSecret(SECRET_NAMES.publishable, publishable.api_key);

  return {
    ok: true,
    backend: {
      kind: "supabase",
      ref,
      url: `https://${ref}.supabase.co`,
      relayUrl: `https://${ref}.supabase.co/functions/v1/${FUNCTION_SLUG}`,
    },
  };
}

function openBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  const [file, args] =
    platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawnFn(file, args, { detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
}

/**
 * One sign-in in the browser, caught on a loopback port. The final step goes
 * through the owner's helper, which holds the app secret this download cannot.
 */
async function signInToSupabase({ oauth, api = API, fetchFn = fetch, open = openBrowser, timeoutMs = 300000 }) {
  const port = oauth.port || DEFAULT_SIGN_IN_PORT;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Signed in</title><p style='font:20px system-ui;margin:20vh auto;text-align:center'>You're signed in. You can close this window.</p>");
      clearTimeout(timer);
      server.close();
      if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) {
        reject(Object.assign(new Error("Sign-in did not finish."), { code: "SIGN_IN_FAILED" }));
      } else resolve(u.searchParams.get("code"));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(Object.assign(new Error("Sign-in timed out."), { code: "SIGN_IN_TIMEOUT" }));
    }, timeoutMs);
    server.on("error", err => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Another sign-in is already open. Finish or close it, then try again."), { code: err.code === "EADDRINUSE" ? "SIGN_IN_BUSY" : "SIGN_IN_FAILED" }));
    });
    server.listen(port, "127.0.0.1", () => {
      const params = new URLSearchParams({
        client_id: oauth.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      open(`${api}/v1/oauth/authorize?${params}`);
    });
  });

  const res = await fetchFn(`${oauth.helperUrl.replace(/\/$/, "")}/api/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw Object.assign(new Error("Sign-in did not finish."), { code: "SIGN_IN_FAILED" });
  return data.access_token;
}

/** Asks the helper whether sign-in is switched on, so a fix never needs a new download. */
async function readHelperConfig({ helperUrl, fetchFn = fetch }) {
  try {
    const res = await fetchFn(`${helperUrl.replace(/\/$/, "")}/api/config`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Connects a backend without the person ever seeing a dashboard, URL or key.
 * Returns a plain reason when the product has not been set up for sign-in yet.
 */
async function connectBackend({ product, env = process.env, storeSecret, confirmCost, session = {}, signIn = signInToSupabase, provision = provisionSupabase, fetchFn = fetch }) {
  // The session keeps the sign-in for a retry, so answering a cost question never means signing in twice.
  // Deliberately not SUPABASE_ACCESS_TOKEN: a developer's unrelated token must never be used silently.
  if (!session.accessToken) session.accessToken = env.AIOS_SUPABASE_ACCESS_TOKEN || null;
  if (!session.accessToken) {
    const notReady = { ok: false, code: "OWNER_SETUP_NEEDED", message: "Phone access is not switched on for this copy yet." };
    if (!product?.signInHelperUrl) return notReady;
    const config = await readHelperConfig({ helperUrl: product.signInHelperUrl, fetchFn });
    if (!config) return { ok: false, code: "HELPER_UNREACHABLE", message: "Could not reach the sign-in service. Check your connection and try again." };
    if (!config.configured) return notReady;
    session.accessToken = await signIn({ oauth: { clientId: config.clientId, port: config.port, helperUrl: product.signInHelperUrl }, fetchFn });
  }
  return provision({ accessToken: session.accessToken, storeSecret, confirmCost });
}

module.exports = { SECRET_NAMES, PROJECT_NAME, provisionSupabase, signInToSupabase, readHelperConfig, connectBackend, openBrowser };
