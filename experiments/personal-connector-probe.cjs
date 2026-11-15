"use strict";

const { randomUUID, createHash, timingSafeEqual } = require("node:crypto");
const { createFileStore, createRelayServer } = require("../lib/relay-host.cjs");
const { queueOrganizerRequest } = require("../lib/request-flow.cjs");

const VERSION = "2025-06-18";
const SUPPORTED = new Set(["2025-03-26", VERSION, "2025-11-25"]);
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validId = value => typeof value === "string" && ID.test(value);
const digest = value => createHash("sha256").update(value).digest();
const reply = (status, body) => ({ status, body, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const failure = (status, message) => reply(status, { error: message });
const reportTool = {
  name: "report_result",
  description: "Record the result of a single AI-first OS connector test attempt.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["attempt_id", "event_id", "result"],
    properties: {
      attempt_id: { type: "string", format: "uuid" },
      event_id: { type: "string", format: "uuid" },
      result: { type: "string", maxLength: 120 },
    },
  },
};

/** Synthetic transport probe. One process and one private file per run. No board credentials or references. */
function createConnectorProbe({ file, museToken, grokToken, now = Date.now }) {
  if (![museToken, grokToken].every(token => typeof token === "string" && token.length >= 32) || museToken === grokToken) {
    throw new Error("Supply two distinct, randomly generated probe tokens.");
  }
  const credentials = { muse: digest(museToken), grok: digest(grokToken) };
  const store = createFileStore({ file, now });
  let pending = Promise.resolve();
  function transaction(fn) {
    const result = pending.then(async () => {
      const data = await store.getState("probe") || { requests: {}, attempts: {} };
      const { value, changed } = fn(data);
      if (changed) await store.setState("probe", data);
      return value;
    });
    pending = result.catch(() => {});
    return result;
  }

  async function submit(body) {
    const key = body?.idempotency_key;
    const words = body?.text;
    if (!validId(key) || typeof words !== "string" || !/^AIOS probe [a-z0-9]{6,40}$/.test(words)) {
      return failure(400, "Use a UUID and the synthetic text AIOS probe followed by a random identifier.");
    }
    return transaction(data => {
      const existing = Object.values(data.requests).find(item => item.key === key);
      if (existing && existing.text !== words) return { value: failure(409, "That key was used for different text.") };
      if (existing) return { value: reply(200, existing.receipt) };
      if (Object.keys(data.requests).length >= 20) return { value: failure(429, "This probe has accepted its maximum number of test requests.") };
      const receipt = { request_id: randomUUID(), state: "queued", updated_at: new Date(now()).toISOString() };
      data.requests[receipt.request_id] = { key, text: words, receipt };
      return { changed: true, value: reply(201, receipt) };
    });
  }

  async function status(id) {
    return transaction(data => {
      const record = validId(id) && data.requests[id];
      return { value: record ? reply(200, record.receipt) : failure(404, "Request unavailable.") };
    });
  }

  async function prepare(text, ttlMs = 300_000) {
    if (typeof text !== "string" || !/^[a-z0-9]{6,40}$/.test(text) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 600_000) {
      throw new Error("Use a synthetic alphanumeric challenge and a bounded timeout.");
    }
    return transaction(data => {
      const attempts = Object.values(data.attempts);
      if (attempts.length >= 20) throw new Error("This probe has reached its test-attempt limit.");
      if (attempts.some(item => item.expires > now() && !item.callback && !item.stopped && item.delivery !== "rejected")) {
        throw new Error("A probe attempt is still outstanding.");
      }
      const attempt_id = randomUUID();
      data.attempts[attempt_id] = { text, expires: now() + ttlMs, delivery: "prepared" };
      return { changed: true, value: { attempt_id, text } };
    });
  }

  async function start(text, send) {
    if (typeof send !== "function") throw new Error("Supply the test webhook transport explicitly.");
    const payload = await prepare(text);
    const changeDelivery = delivery => transaction(data => {
      data.attempts[payload.attempt_id].delivery = delivery;
      return { changed: true, value: { ...payload, delivery } };
    });
    await changeDelivery("sending");
    let response;
    try { response = await send(payload); }
    catch { return changeDelivery("uncertain"); }
    if (response?.status === 200) return changeDelivery("accepted");
    if (response?.status >= 400 && response.status < 500) return changeDelivery("rejected");
    return changeDelivery("uncertain");
  }

  async function report({ attempt_id, event_id, result } = {}) {
    if (!validId(attempt_id) || !validId(event_id) || typeof result !== "string" || result.length > 120) {
      return failure(400, "Invalid probe result.");
    }
    return transaction(data => {
      const attempt = data.attempts[attempt_id];
      if (!attempt) return { value: failure(404, "Attempt unavailable.") };
      if (attempt.callback) {
        const duplicate = attempt.callback.event_id === event_id && attempt.callback.result === result;
        return { value: duplicate ? reply(200, { state: "stored", attempt_id }) : failure(409, "A different result was already saved.") };
      }
      if (!["sending", "accepted", "uncertain"].includes(attempt.delivery) || attempt.stopped || attempt.expires <= now()) {
        return { value: failure(409, "This attempt is no longer accepting results.") };
      }
      if (result !== attempt.text.toUpperCase()) return { value: failure(422, "The reply did not match the challenge.") };
      attempt.callback = { event_id, result, at: new Date(now()).toISOString() };
      return { changed: true, value: reply(200, { state: "stored", attempt_id }) };
    });
  }

  async function mcp({ method, headers, body }) {
    if (method !== "POST") return { ...failure(405, "Use POST."), headers: { allow: "POST" } };
    if (headers["mcp-protocol-version"] && !SUPPORTED.has(headers["mcp-protocol-version"])) {
      return failure(400, "Unsupported MCP protocol version.");
    }
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return failure(400, "Invalid JSON-RPC message.");
    if (body.method === "notifications/initialized" && body.id === undefined) return reply(202, null);
    if (typeof body.id !== "string" && !Number.isSafeInteger(body.id)) return failure(400, "Invalid request ID.");
    const envelope = { jsonrpc: "2.0", id: body.id };
    const result = value => reply(200, { ...envelope, result: value });
    if (body.method === "initialize") return result({
      protocolVersion: SUPPORTED.has(body.params?.protocolVersion) ? body.params.protocolVersion : VERSION,
      serverInfo: { name: "ai-first-os-connector-probe", version: "0.1.0" },
      capabilities: { tools: {} },
    });
    if (body.method === "ping") return result({});
    if (body.method === "tools/list") return result({ tools: [reportTool] });
    if (body.method === "tools/call" && body.params?.name === reportTool.name) {
      const saved = await report(body.params.arguments || {});
      return result({ ...(saved.status >= 400 ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(saved.body) }] });
    }
    return reply(200, { ...envelope, error: { code: -32601, message: "Method or tool unavailable" } });
  }

  async function handle({ method, path, headers, body }) {
    const provider = path === "/mcp" ? "grok" : ["/requests", "/status"].includes(path) ? "muse" : null;
    if (!provider) return failure(404, "Route unavailable.");
    if (headers.origin) return failure(403, "This probe only accepts server connections.");
    const key = /^Bearer ([^\s]+)$/i.exec(headers.authorization || "")?.[1];
    if (!key || !timingSafeEqual(digest(key), credentials[provider])) return failure(401, "Unauthorized.");
    if (method === "POST" && !/^application\/json(?:\s*;|$)/i.test(headers["content-type"] || "")) {
      return failure(415, "Use application/json.");
    }
    if (provider === "grok") return mcp({ method, headers, body });
    if (method !== "POST") return failure(405, "Use POST.");
    if (path === "/requests") return submit(body);
    return status(body?.request_id);
  }

  return {
    server: createRelayServer({ relay: { handle } }),
    start,
    // Only the local test harness holds a board reference; the provider never can access this operation.
    syncRequests: ({ board, manifest }) => transaction(data => {
      let changed = false;
      for (const item of Object.values(data.requests)) {
        const row = queueOrganizerRequest({
          task: item.text, manifest, source: "probe-muse", sourceRequest: item.receipt.request_id,
          board: { addTask: input => board.addTask({ ...input, from: "Muse", note: "Saved from the Muse connector probe.", deduplicateSource: true }) },
        });
        if (item.receipt.state !== row.Status || item.receipt.task_id !== row.ID) {
          Object.assign(item.receipt, { state: row.Status, task_id: row.ID, updated_at: new Date(now()).toISOString() });
          changed = true;
        }
      }
      return { changed, value: Object.keys(data.requests).length };
    }),
    inspect: id => transaction(data => ({ value: data.attempts[id] || null })),
    stop: id => transaction(data => {
      const attempt = data.attempts[id];
      if (!attempt) return { value: false };
      attempt.stopped = true;
      return { changed: true, value: true };
    }),
  };
}

module.exports = { createConnectorProbe };
