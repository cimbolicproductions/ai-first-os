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
const MAX_SHEET_RESULTS = 16;
const MAX_SHEET_TASKS = 20;
const SHEET_STATUSES = ["Open", "In progress", "Waiting on Dom", "Done"];
// Bumped whenever the relay learns new routes, so the computer can tell an older deployment needs updating.
const RELAY_VERSION = 2;
// Personal assistants that may send requests in. Each has its own key, set and revoked by the computer.
const CONNECTOR_NAMES = ["muse"];
const MAX_CONNECTOR_REQUESTS_PER_DAY = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_STATES = new Set(["queued", "open", "working", "needs_you", "done"]);

/** What Muse reads when the owner asks it to create a custom connector. It holds no secrets. */
function museApiDocument(baseUrl) {
  const receipt = {
    type: "object", required: ["request_id", "state", "message", "updated_at"],
    properties: {
      request_id: { type: "string", format: "uuid", description: "Keep this to check on the request later." },
      state: { type: "string", enum: [...AGENT_STATES], description: "queued: saved, not yet on the board. open: on the board, waiting its turn. working: being worked on. needs_you: the owner has a question to answer in AI-first OS. done: finished." },
      message: { type: "string", description: "One plain sentence to tell the owner." },
      task_id: { type: "string", description: "The board task it became, such as P12." },
      title: { type: "string" },
      question: { type: "string", description: "When state is needs_you: the question waiting for the owner. They answer it in AI-first OS, not here." },
      answer: { type: "string", description: "When state is done: the result, shortened." },
      updated_at: { type: "string", format: "date-time" },
      computer_online: { type: "boolean" },
      computer_last_seen: { type: "string", format: "date-time" },
    },
  };
  const problem = { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } };
  const json = schema => ({ content: { "application/json": { schema } } });
  return {
    openapi: "3.1.0",
    info: {
      title: "AI-first OS",
      version: String(RELAY_VERSION),
      description: "Send the owner's requests to their AI-first OS board and check on them. AI-first OS asks the owner directly for anything it needs; this connector cannot answer its questions or approve anything.",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths: {
      "/requests": { post: {
        operationId: "submitRequest",
        summary: "Add a request to the owner's AI-first OS board, in the owner's words.",
        requestBody: { required: true, ...json({
          type: "object", additionalProperties: false, required: ["text", "idempotency_key"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: MAX_REQUEST_CHARS },
            idempotency_key: { type: "string", format: "uuid", description: "Make a new UUID for each new request. Reuse the same one only when retrying that same request." },
          },
        }) },
        responses: {
          201: { description: "Saved.", ...json(receipt) }, 200: { description: "Already saved under this key.", ...json(receipt) },
          400: { description: "Invalid input.", ...json(problem) }, 401: { description: "Wrong or revoked token.", ...json(problem) },
          409: { description: "Key already used for different text.", ...json(problem) }, 429: { description: "Too many waiting or sent today.", ...json(problem) },
        },
      } },
      "/status": { post: {
        operationId: "getRequestStatus",
        summary: "Check on a request this connector sent.",
        requestBody: { required: true, ...json({
          type: "object", additionalProperties: false, required: ["request_id"],
          properties: { request_id: { type: "string", format: "uuid" } },
        }) },
        responses: { 200: { description: "Latest status.", ...json(receipt) }, 401: { description: "Wrong or revoked token.", ...json(problem) }, 404: { description: "No such request from this connector.", ...json(problem) } },
      } },
    },
  };
}

function validSheetRequestId(id) {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
}

/** Explicit task-sheet operations never enter the queue that runs an AI agent. */
function parseSheetOperation(body) {
  const { requestId, action } = body || {};
  if (!validSheetRequestId(requestId)) return null;
  if (action === "list") return { requestId, action };
  if (action === "add") {
    if (!Array.isArray(body.tasks) || !body.tasks.length || body.tasks.length > MAX_SHEET_TASKS) return null;
    const tasks = body.tasks.map(task => typeof task === "string" ? task.trim() : "");
    if (tasks.some(task => !task || task.length > 500) || tasks.join("\n").length > MAX_REQUEST_CHARS) return null;
    return { requestId, action, tasks };
  }
  if (action !== "update" || typeof body.id !== "string" || !/^P[1-9][0-9]{0,18}$/.test(body.id) ||
      typeof body.revision !== "string" || !/^[0-9a-f]{24}$/.test(body.revision)) return null;
  const task = typeof body.task === "string" ? body.task.trim() : undefined;
  const status = body.status;
  if (body.task !== undefined && (!task || task.length > 500)) return null;
  if (status !== undefined && !SHEET_STATUSES.includes(status)) return null;
  if (task === undefined && status === undefined) return null;
  return { requestId, action, id: body.id, revision: body.revision, task, status };
}

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

  async function connectors() {
    const linked = await store.getState("connectors");
    return linked && typeof linked === "object" && !Array.isArray(linked) ? linked : {};
  }

  async function who(headers) {
    const match = /^Bearer\s+(.+)$/i.exec(headers.authorization || "");
    if (!match) return null;
    const hash = await sha256Hex(match[1].trim());
    if (sameHex(hash, phoneTokenHash)) return "phone";
    if (sameHex(hash, homeTokenHash)) return "home";
    const linked = await connectors();
    for (const name of CONNECTOR_NAMES) if (sameHex(hash, linked[name]?.tokenHash)) return name;
    return null;
  }

  /** The same key from the same connector always names the same request, so one atomic claim settles retries. */
  async function requestIdFor(connector, key) {
    const h = await sha256Hex(`${connector}\n${key.toLowerCase()}`);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  function agentReceipt(record, heartbeat) {
    const home = homeStatus(heartbeat, new Date(now()).getTime());
    const task = record.task_id ? ` (${record.task_id})` : "";
    const words = {
      queued: home.online ? "Saved. Your computer will put it on the board shortly." : "Saved. Your computer is offline, so it will pick this up when it is back.",
      open: `On the board${task}, waiting its turn.`,
      working: `Being worked on now${task}.`,
      needs_you: `It needs your answer in AI-first OS${task}.`,
      done: `Finished${task}.`,
    };
    return {
      request_id: record.request_id,
      state: record.state,
      message: words[record.state] || "Saved.",
      ...(record.task_id ? { task_id: record.task_id } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(record.question ? { question: record.question } : {}),
      ...(record.answer ? { answer: record.answer } : {}),
      updated_at: record.updated_at,
      computer_online: home.online,
      ...(home.lastSeen ? { computer_last_seen: home.lastSeen } : {}),
    };
  }

  // Muse can add a request and read the status of its own requests. Nothing else: no answers, approvals or board edits.
  const museRoutes = {
    async "POST requests"(body) {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
      if (!text) return bad(400, "EMPTY_REQUEST", "Say what you need first.");
      if (text.length > MAX_REQUEST_CHARS) return bad(413, "TOO_LONG", `Keep a request under ${MAX_REQUEST_CHARS} characters.`);
      if (!UUID.test(key)) return bad(400, "INVALID_KEY", "Send a new UUID as idempotency_key, and reuse it only when retrying the same request.");
      const request_id = await requestIdFor("muse", key);
      const digest = await sha256Hex(text);
      const stateKey = `agentreq:${request_id}`;
      const heartbeat = await store.getState("heartbeat");
      let record = await store.getState(stateKey);
      if (!record) {
        const open = await store.list(["request", "sheet", "musereq"]);
        if (open.length >= MAX_OPEN_REQUESTS) return bad(429, "QUEUE_FULL", "Your computer has plenty waiting already. Try again later.");
        const today = new Date(now()).toISOString().slice(0, 10);
        const daily = await store.getState("museDaily");
        const sent = daily?.day === today ? Number(daily.sent) || 0 : 0;
        if (sent >= MAX_CONNECTOR_REQUESTS_PER_DAY) return bad(429, "DAILY_LIMIT", "That is the most requests Muse can send today.");
        const at = new Date(now()).toISOString();
        const claim = await store.claimState(stateKey, { connector: "muse", request_id, digest, state: "queued", created_at: at, updated_at: at });
        record = claim.value;
        if (claim.created) {
          await store.setState("museDaily", { day: today, sent: sent + 1 });
          const item = await store.add("musereq", { request_id, text });
          await ring({ row: `R${(Number(item.id) % 999999) + 1}`, event: "assigned", from: "muse", machine: "muse" });
          return reply(201, agentReceipt(record, heartbeat));
        }
      }
      if (record?.connector !== "muse" || record.digest !== digest) {
        return bad(409, "KEY_REUSED", "That idempotency_key was already used for a different request. Make a new UUID for a new request.");
      }
      // A retry. If an earlier try saved the receipt but not the message for the computer, put the message back;
      // the computer adopts each request ID only once.
      if (record.state === "queued") {
        const waiting = await store.list(["musereq"]);
        if (!waiting.some(item => item.body.request_id === request_id)) await store.add("musereq", { request_id, text });
      }
      return reply(200, agentReceipt(record, heartbeat));
    },

    async "POST status"(body) {
      const id = typeof body.request_id === "string" ? body.request_id.trim().toLowerCase() : "";
      if (!UUID.test(id)) return bad(400, "INVALID_REQUEST_ID", "Send the request_id from the receipt.");
      const [record, heartbeat] = await Promise.all([store.getState(`agentreq:${id}`), store.getState("heartbeat")]);
      if (record?.connector !== "muse") return bad(404, "REQUEST_MISSING", "No request with that ID came from this connector.");
      return reply(200, agentReceipt(record, heartbeat));
    },
  };

  async function sheetReceipts() {
    const receipts = await store.getState("sheetReceipts");
    return Array.isArray(receipts) ? receipts : [];
  }

  const routes = {
    async "POST sheet"(body) {
      const op = parseSheetOperation(body);
      if (!op) return bad(400, "INVALID_SHEET_REQUEST", "Check the task details and try again.");
      const [heartbeat, receipts, open] = await Promise.all([
        store.getState("heartbeat"), sheetReceipts(), store.list(["request", "sheet"]),
      ]);
      const digest = await sha256Hex(JSON.stringify(op));
      const existing = receipts.find(receipt => receipt.requestId === op.requestId);
      const queued = open.find(item => item.kind === "sheet" && item.body.requestId === op.requestId);
      if (existing || queued) {
        if ((existing?.operationDigest || queued?.body.operationDigest) !== digest) {
          return bad(409, "SHEET_REQUEST_CONFLICT", "That request already has different task details.");
        }
        return reply(200, { ok: true, requestId: op.requestId });
      }
      if (heartbeat?.sheetTasks !== true) return bad(409, "SHEET_UNAVAILABLE", "Connect your task sheet on the computer first.");
      if (open.length >= MAX_OPEN_REQUESTS) return bad(429, "QUEUE_FULL", "Your computer has plenty waiting already.");
      const item = await store.add("sheet", { ...op, operationDigest: digest });
      await ring({ row: `R${(Number(item.id) % 999999) + 1}`, event: "assigned", from: "phone", machine: "phone" });
      return reply(200, { ok: true, requestId: op.requestId });
    },

    async "POST sheetstatus"(body) {
      if (!validSheetRequestId(body.requestId)) return bad(400, "INVALID_SHEET_REQUEST", "That task request is invalid.");
      const [receipts, open] = await Promise.all([sheetReceipts(), store.list(["sheet"])]);
      const receipt = receipts.find(item => item.requestId === body.requestId);
      if (receipt) {
        const { requestId, action, success, message, tasks } = receipt;
        return reply(200, { ok: true, state: "finished", receipt: { requestId, action, success, message, tasks } });
      }
      if (open.some(item => item.body.requestId === body.requestId)) return reply(200, { ok: true, state: "queued" });
      return bad(404, "SHEET_REQUEST_MISSING", "The result is unavailable. Check the task sheet before trying again.");
    },

    async "POST request"(body) {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return bad(400, "EMPTY_REQUEST", "Say what you need first.");
      if (text.length > MAX_REQUEST_CHARS) return bad(413, "TOO_LONG", "That is too long to send.");
      const open = await store.list(["request", "sheet"]);
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
        store.list(["request", "sheet"]),
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
        sheetTasks: heartbeat?.sheetTasks === true,
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
        sheetTasks: body.sheetTasks === true,
      });
      return reply(200, { ok: true, version: RELAY_VERSION });
    },

    async "GET pull"() {
      const [items, push] = await Promise.all([store.list(["request", "answer", "sheet", "musereq"]), store.getState("push")]);
      return reply(200, { ok: true, items, push: push || [] });
    },

    /** Sets or revokes a connector's key. Only its hash is kept; a null hash turns the connector off. */
    async "POST connector"(body) {
      if (!CONNECTOR_NAMES.includes(body.name)) return bad(400, "INVALID_CONNECTOR", "Unknown connector.");
      const linked = await connectors();
      if (body.tokenHash === null) {
        delete linked[body.name];
      } else {
        const hash = typeof body.tokenHash === "string" ? body.tokenHash.toLowerCase() : "";
        if (!/^[0-9a-f]{64}$/.test(hash) || sameHex(hash, phoneTokenHash) || sameHex(hash, homeTokenHash)) {
          return bad(400, "INVALID_CONNECTOR_KEY", "That connector key cannot be used.");
        }
        const baseUrl = typeof body.baseUrl === "string" && /^https?:\/\/[^\s"'<>\\]{1,300}$/.test(body.baseUrl) ? body.baseUrl.replace(/\/+$/, "") : null;
        if (!baseUrl) return bad(400, "INVALID_CONNECTOR_URL", "That address cannot be used.");
        linked[body.name] = { tokenHash: hash, baseUrl, since: new Date(now()).toISOString() };
      }
      await store.setState("connectors", linked);
      return reply(200, { ok: true });
    },

    /** The computer reports where each connector request stands. It decides the state; the connector only reads it. */
    async "POST agentstatus"(body) {
      const updates = Array.isArray(body.updates) ? body.updates.slice(0, 50) : [];
      const clip = (value, max) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
      let saved = 0;
      for (const update of updates) {
        const id = typeof update?.request_id === "string" ? update.request_id.toLowerCase() : "";
        if (!UUID.test(id) || !AGENT_STATES.has(update.state)) continue;
        const record = await store.getState(`agentreq:${id}`);
        if (!record) continue;
        const next = {
          connector: record.connector, request_id: record.request_id, digest: record.digest, created_at: record.created_at,
          state: update.state,
          task_id: /^P[1-9]\d{0,6}$/.test(update.task_id || "") ? update.task_id : record.task_id,
          title: clip(update.title, 120),
          question: update.state === "needs_you" ? clip(update.question, 600) : undefined,
          answer: update.state === "done" ? clip(update.answer, 1200) : undefined,
          updated_at: new Date(now()).toISOString(),
        };
        await store.setState(`agentreq:${id}`, JSON.parse(JSON.stringify(next)));
        saved++;
      }
      return reply(200, { ok: true, saved });
    },

    async "POST receipt"(body) {
      if (!validSheetRequestId(body.requestId) || typeof body.success !== "boolean" ||
          typeof body.message !== "string" || body.message.length > 400) {
        return bad(400, "INVALID_SHEET_RECEIPT", "Invalid task sheet result.");
      }
      const receipts = await sheetReceipts();
      if (receipts.some(item => item.requestId === body.requestId)) return reply(200, { ok: true });
      const active = (await store.list(["sheet"])).find(item => item.body.requestId === body.requestId);
      if (!active) return bad(404, "SHEET_REQUEST_MISSING", "That task request is no longer waiting.");
      const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 50).map(task => ({
        id: String(task?.id || "").slice(0, 20),
        task: String(task?.task || "").slice(0, 500),
        status: String(task?.status || "").slice(0, 40),
        to: String(task?.to || "").slice(0, 80),
        revision: String(task?.revision || "").slice(0, 200),
      })) : [];
      await store.setState("sheetReceipts", [...receipts.slice(-(MAX_SHEET_RESULTS - 1)), {
        requestId: body.requestId,
        action: active.body.action,
        operationDigest: active.body.operationDigest,
        success: body.success,
        message: body.message,
        tasks,
      }]);
      return reply(200, { ok: true });
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
    try {
      // The one public route: Muse's description, only while Muse is connected. No secrets in it.
      if (key === "GET museapi") {
        const muse = (await connectors()).muse;
        return muse?.baseUrl ? reply(200, museApiDocument(muse.baseUrl)) : bad(404, "NOT_FOUND", "Not found.");
      }
      const caller = await who(headers);
      const table = caller === "phone" ? routes : caller === "home" ? homeRoutes : caller === "muse" ? museRoutes : null;
      if (!table) return bad(401, "UNAUTHORIZED", "This link is not valid.");
      if (!Object.hasOwn(table, key)) return bad(403, "FORBIDDEN", "Not allowed.");
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
    /** Insert only if the key is new, in one database statement, so two racing callers cannot both win. */
    async claimState(key, value) {
      const rows = await call("/aios_state?on_conflict=key", {
        method: "POST",
        headers: { prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ key, value, updated_at: new Date(now()).toISOString() }),
      });
      if (Array.isArray(rows) && rows.length) return { created: true, value: rows[0].value };
      const existing = await call(`/aios_state?key=eq.${encodeURIComponent(key)}&select=value`);
      return { created: false, value: existing[0]?.value ?? null };
    },
  };
}

module.exports = { SCHEMA_SQL, ONLINE_WINDOW_MS, MAX_REQUEST_CHARS, RELAY_VERSION, CONNECTOR_NAMES, parseSheetOperation, parsePushEndpoint, sha256Hex, createRelay, createPostgrestStore, homeStatus, museApiDocument };
