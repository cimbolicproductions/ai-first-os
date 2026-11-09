"use strict";

/**
 * The one place the phone and the computer meet. The same code runs in a Supabase
 * Edge Function and in a local Node server, so it uses only web-standard APIs and
 * has no imports.
 *
 * The phone holds one token and the computer another; only their hashes live on
 * the server. Requests wait here while the computer is off.
 */

const MAX_REQUEST_CHARS = 4000;
const MAX_NOTICE_CHARS = 1200;
const MAX_OPEN_REQUESTS = 50;
const MAX_PUSH_SUBSCRIPTIONS = 5;
const ONLINE_WINDOW_MS = 150000;

/** The phone can register only URLs issued by supported browser push services. */
function parsePushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 1000 || !endpoint.startsWith("https://")) return null;
  if (/[\s\\]/.test(endpoint)) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    const host = url.hostname;
    const supported = host === "fcm.googleapis.com" ||
      host === "push.services.mozilla.com" || host === "updates.push.services.mozilla.com" ||
      host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com");
    return supported ? url : null;
  } catch {
    return null;
  }
}

const SCHEMA_SQL = `
create table if not exists aios_items (
  id bigserial primary key,
  kind text not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index if not exists aios_items_open on aios_items (kind) where consumed_at is null;
create table if not exists aios_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table aios_items enable row level security;
alter table aios_state enable row level security;
`;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function homeStatus(heartbeat, nowMs) {
  if (!heartbeat?.at) return { online: false, lastSeen: null };
  return { online: nowMs - new Date(heartbeat.at).getTime() < ONLINE_WINDOW_MS, lastSeen: heartbeat.at };
}

function createRelay({ store, phoneTokenHash, homeTokenHash, now = () => new Date(), ring = async () => {} }) {
  if (!phoneTokenHash || !homeTokenHash) throw new Error("Relay tokens are not configured.");

  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  const reply = (status, body) => ({ status, headers: { "content-type": "application/json", ...CORS }, body });
  const bad = (status, code, message) => reply(status, { ok: false, code, message });

  async function who(headers) {
    const match = /^Bearer\s+(.+)$/i.exec(headers.authorization || "");
    if (!match) return null;
    const hash = await sha256Hex(match[1].trim());
    if (sameHex(hash, phoneTokenHash)) return "phone";
    if (sameHex(hash, homeTokenHash)) return "home";
    return null;
  }

  const routes = {
    async "POST request"(body) {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return bad(400, "EMPTY_REQUEST", "Say what you need first.");
      if (text.length > MAX_REQUEST_CHARS) return bad(413, "TOO_LONG", "That is too long to send.");
      const open = await store.list(["request"]);
      if (open.length >= MAX_OPEN_REQUESTS) return bad(429, "QUEUE_FULL", "Your computer has plenty waiting already.");
      const to = typeof body.to === "string" && /^[a-z0-9_-]{2,32}$/.test(body.to) ? body.to : null;
      const item = await store.add("request", { text, to });
      await ring({ row: `R${(Number(item.id) % 999999) + 1}`, event: "assigned", from: "phone", machine: "phone" });
      return reply(200, { ok: true, id: item.id });
    },

    async "GET status"() {
      const [heartbeat, notices, requests, push] = await Promise.all([
        store.getState("heartbeat"),
        store.list(["notice"]),
        store.list(["request"]),
        store.getState("push"),
      ]);
      return reply(200, {
        ok: true,
        home: homeStatus(heartbeat, new Date(now()).getTime()),
        queued: requests.length,
        notices: notices.map(n => n.body),
        summary: heartbeat?.summary || null,
        agents: heartbeat?.agents || [],
        vapidKey: heartbeat?.vapidKey || null,
        pushCount: (push || []).length,
      });
    },

    async "POST answer"(body) {
      const notices = await store.list(["notice"]);
      const hit = notices.find(n => n.body.id === body.noticeId);
      if (!hit) return bad(404, "NOTICE_MISSING", "That question is already settled.");
      if (hit.body.digest !== body.digest) return bad(409, "NOTICE_MISMATCH", "That answer was for a different question.");
      if (!hit.body.choices?.some(c => c.value === body.value)) return bad(400, "INVALID_CHOICE", "That is not one of the choices.");
      await store.add("answer", { noticeId: body.noticeId, digest: body.digest, value: body.value });
      await store.consume([hit.id]);
      await ring({ row: `R${(Number(hit.id) % 999999) + 1}`, event: "assigned", from: "phone", machine: "phone" });
      return reply(200, { ok: true });
    },

    async "POST subscribe"(body) {
      const endpoint = parsePushEndpoint(body.endpoint)?.href;
      if (!endpoint) return bad(400, "INVALID_ENDPOINT", "Could not turn on alerts for this browser.");
      const current = (await store.getState("push")) || [];
      const next = [endpoint, ...current.filter(e => e !== endpoint)].slice(0, MAX_PUSH_SUBSCRIPTIONS);
      await store.setState("push", next);
      return reply(200, { ok: true });
    },
  };

  const homeRoutes = {
    async "POST heartbeat"(body) {
      await store.setState("heartbeat", {
        at: new Date(now()).toISOString(),
        machine: String(body.machine || "home").slice(0, 32),
        summary: body.summary || null,
        agents: Array.isArray(body.agents) ? body.agents.slice(0, 12) : [],
        vapidKey: typeof body.vapidKey === "string" ? body.vapidKey : null,
      });
      return reply(200, { ok: true });
    },

    async "GET pull"() {
      const [items, push] = await Promise.all([store.list(["request", "answer"]), store.getState("push")]);
      return reply(200, { ok: true, items, push: push || [] });
    },

    async "POST ack"(body) {
      await store.consume((body.ids || []).slice(0, 200));
      return reply(200, { ok: true });
    },

    async "POST notice"(body) {
      const n = body.notice || {};
      if (typeof n.id !== "string" || typeof n.text !== "string" || n.text.length > MAX_NOTICE_CHARS) {
        return bad(400, "INVALID_NOTICE", "Invalid notice.");
      }
      const open = await store.list(["notice"]);
      if (!open.some(o => o.body.id === n.id)) await store.add("notice", n);
      return reply(200, { ok: true });
    },

    async "POST resolve"(body) {
      const ids = new Set(body.noticeIds || []);
      const open = await store.list(["notice"]);
      await store.consume(open.filter(o => ids.has(o.body.id)).map(o => o.id));
      return reply(200, { ok: true });
    },
  };

  async function handle({ method, path, headers = {}, body = {} }) {
    if (method === "OPTIONS") return reply(204, null);
    const match = /\/v1\/([a-z]+)\/?$/.exec(path.split("?")[0]);
    if (!match) return bad(404, "NOT_FOUND", "Not found.");
    const key = `${method} ${match[1]}`;
    const caller = await who(headers);
    const table = caller === "phone" ? routes : caller === "home" ? homeRoutes : null;
    if (!table) return bad(401, "UNAUTHORIZED", "This link is not valid.");
    if (!Object.hasOwn(table, key)) return bad(403, "FORBIDDEN", "Not allowed.");
    try {
      return await table[key](body && typeof body === "object" ? body : {});
    } catch {
      return bad(500, "RELAY_ERROR", "Something went wrong. Try again.");
    }
  }

  return { handle };
}

/** Store backed by the Supabase REST interface. Used inside the Edge Function. */
function createPostgrestStore({ url, serviceKey, fetchFn = fetch, now = () => new Date() }) {
  const base = `${url.replace(/\/$/, "")}/rest/v1`;
  const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" };

  async function call(path, init = {}) {
    const res = await fetchFn(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`Store error ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    async add(kind, body) {
      const rows = await call("/aios_items", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({ kind, body }),
      });
      return rows[0];
    },
    async list(kinds) {
      return call(`/aios_items?consumed_at=is.null&kind=in.(${kinds.join(",")})&order=id.asc`);
    },
    async consume(ids) {
      const safe = ids.map(Number).filter(Number.isFinite);
      if (!safe.length) return;
      await call(`/aios_items?id=in.(${safe.join(",")})`, {
        method: "PATCH",
        body: JSON.stringify({ consumed_at: new Date(now()).toISOString() }),
      });
    },
    async getState(key) {
      const rows = await call(`/aios_state?key=eq.${encodeURIComponent(key)}&select=value`);
      return rows[0]?.value ?? null;
    },
    async setState(key, value) {
      await call("/aios_state?on_conflict=key", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key, value, updated_at: new Date(now()).toISOString() }),
      });
    },
  };
}

module.exports = { SCHEMA_SQL, ONLINE_WINDOW_MS, MAX_REQUEST_CHARS, parsePushEndpoint, sha256Hex, createRelay, createPostgrestStore, homeStatus };
