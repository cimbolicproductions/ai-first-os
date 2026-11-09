"use strict";

/**
 * The one piece of AI-first OS that runs on a server the owner controls. It keeps
 * the Supabase app secret, which cannot ship inside a public download, and uses it
 * to finish each person's sign-in. It stores nothing and logs nothing.
 *
 * A stolen sign-in code is useless here without the verifier held by the computer
 * that started the sign-in, and tokens can only be issued to a loopback address.
 */

const API = "https://api.supabase.com";
const SIGN_IN_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${SIGN_IN_PORT}/callback`;
const REQUIRED_SCOPES = Object.freeze([
  "Organizations: Read",
  "Projects: Read and Write",
  "Database: Write",
  "Edge Functions: Write",
  "Secrets: Read and Write",
]);

function createHelper({ env = process.env, fetchFn = fetch, api = API } = {}) {
  const clientId = (env.SUPABASE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = (env.SUPABASE_OAUTH_CLIENT_SECRET || "").trim();
  const configured = Boolean(clientId && clientSecret);

  function config() {
    return { status: 200, body: { ok: true, configured, clientId: configured ? clientId : null, redirectUri: REDIRECT_URI, port: SIGN_IN_PORT } };
  }

  async function exchange(body) {
    if (!configured) return { status: 503, body: { ok: false, code: "NOT_CONFIGURED" } };
    const { code, code_verifier: verifier, redirect_uri: redirectUri } = body && typeof body === "object" ? body : {};
    if (typeof code !== "string" || !code || code.length > 4096) return { status: 400, body: { ok: false, code: "INVALID_REQUEST" } };
    if (typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return { status: 400, body: { ok: false, code: "INVALID_REQUEST" } };
    if (redirectUri !== REDIRECT_URI) return { status: 400, body: { ok: false, code: "INVALID_REDIRECT" } };

    let res;
    try {
      res = await fetchFn(`${api}/v1/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return { status: 502, body: { ok: false, code: "UPSTREAM_UNREACHABLE" } };
    }
    if (!res.ok) return { status: 400, body: { ok: false, code: "SIGN_IN_REJECTED" } };
    const data = await res.json().catch(() => ({}));
    if (typeof data.access_token !== "string" || !data.access_token) return { status: 502, body: { ok: false, code: "BAD_UPSTREAM_REPLY" } };
    return { status: 200, body: { ok: true, access_token: data.access_token } };
  }

  return { config, exchange, configured };
}

/** Adapts the helper to a Node-style serverless function. */
function asFunction(run, method) {
  return async function handler(req, res) {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    if (req.method !== method) {
      res.statusCode = 405;
      res.end(JSON.stringify({ ok: false, code: "METHOD_NOT_ALLOWED" }));
      return;
    }
    const out = await run(createHelper(), req.body);
    res.statusCode = out.status;
    res.end(JSON.stringify(out.body));
  };
}

module.exports = { createHelper, asFunction, REDIRECT_URI, SIGN_IN_PORT, REQUIRED_SCOPES };
