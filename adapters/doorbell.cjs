"use strict";

const ALLOWED_EVENTS = new Set([
  "assigned",
  "claimed",
  "building",
  "blocked",
  "waiting_on_user",
  "waiting_on_dom",
  "handed_to_router",
  "handed_to_juno",
  "done",
  "failed",
]);

const CHANNEL_TOPIC = "realtime:agent-board-doorbell";
const BROADCAST_EVENT = "board_signal";

class DoorbellError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DoorbellError";
    this.code = code;
  }
}

/**
 * Content-free doorbell signal validation.
 * Strips any extra keys so no prompt, command, or approval prose can ever
 * ride the fast event channel.
 */
function sanitizeSignal(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DoorbellError("INVALID_SIGNAL", "Doorbell signal must be a plain object.");
  }
  const row = String(input.row || "").trim();
  const event = String(input.event || "").trim();
  const from = String(input.from || "").trim().toLowerCase();
  const machine = String(input.machine || "").trim().toLowerCase();
  const ts = input.ts ? String(input.ts).trim() : new Date().toISOString();

  if (!/^P[1-9]\d{0,3}$/.test(row)) throw new DoorbellError("INVALID_SIGNAL", "Invalid row ID.");
  if (!ALLOWED_EVENTS.has(event)) throw new DoorbellError("INVALID_SIGNAL", "Unsupported doorbell event.");
  if (!/^[a-z0-9_-]{2,32}$/.test(from)) throw new DoorbellError("INVALID_SIGNAL", "Invalid actor identifier.");
  if (!/^[a-z0-9_-]{2,32}$/.test(machine)) throw new DoorbellError("INVALID_SIGNAL", "Invalid machine identifier.");
  if (!Number.isFinite(Date.parse(ts))) throw new DoorbellError("INVALID_SIGNAL", "Invalid timestamp.");

  return Object.freeze({ row, event, from, machine, ts });
}

function toRealtimeWsUrl(supabaseUrl, apiKey) {
  if (!supabaseUrl || !apiKey) {
    throw new DoorbellError("CONFIG_REQUIRED", "supabaseUrl and apiKey are required.");
  }
  if (/^wss?:\/\//i.test(supabaseUrl)) {
    const u = new URL(supabaseUrl);
    if (!u.searchParams.has("apikey")) u.searchParams.set("apikey", apiKey);
    if (!u.searchParams.has("vsn")) u.searchParams.set("vsn", "1.0.0");
    return u.toString();
  }
  const parsed = new URL(supabaseUrl);
  const wsProto = parsed.protocol === "http:" ? "ws:" : "wss:";
  const url = new URL(`${wsProto}//${parsed.host}/realtime/v1/websocket`);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("vsn", "1.0.0");
  return url.toString();
}

function createDoorbellClient({
  supabaseUrl,
  apiKey,
  topic = CHANNEL_TOPIC,
  heartbeatMs = 25000,
  reconnectBaseMs = 500,
  reconnectMaxMs = 15000,
  onSignal = () => {},
  onError = () => {},
  onStateChange = () => {},
}) {
  const wsUrl = toRealtimeWsUrl(supabaseUrl, apiKey);
  let ws = null;
  let refCounter = 1;
  let joinRef = null;
  let joined = false;
  let closed = false;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let attempt = 0;
  let joinWaiters = [];

  const nextRef = () => String(refCounter++);

  function setJoined(value) {
    if (joined === value) return;
    joined = value;
    onStateChange(joined ? "joined" : "disconnected");
    if (joined) {
      const waiters = joinWaiters;
      joinWaiters = [];
      waiters.forEach(w => w.resolve());
    }
  }

  function clearTimers() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function sendRaw(frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(reconnectBaseMs * Math.pow(2, attempt), reconnectMaxMs);
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (closed) return;
    if (typeof WebSocket !== "function") {
      throw new DoorbellError("RUNTIME_UNSUPPORTED", "Node 22+ global WebSocket is required.");
    }
    ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => {
      attempt = 0;
      joinRef = nextRef();
      sendRaw({
        topic,
        event: "phx_join",
        payload: { config: { broadcast: { self: false, ack: false } } },
        ref: joinRef,
        join_ref: joinRef,
      });
      heartbeatTimer = setInterval(() => {
        sendRaw({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef() });
      }, heartbeatMs);
    });

    ws.addEventListener("message", ev => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.topic === topic && msg.event === "phx_reply" && msg.ref === joinRef) {
        if (msg.payload?.status === "ok") setJoined(true);
        else onError(new DoorbellError("JOIN_FAILED", `Realtime join rejected: ${JSON.stringify(msg.payload)}`));
        return;
      }
      if (msg.topic === topic && msg.event === "broadcast" && msg.payload?.event === BROADCAST_EVENT) {
        try {
          const clean = sanitizeSignal(msg.payload?.payload);
          onSignal(clean);
        } catch (err) {
          onError(err);
        }
      }
    });

    ws.addEventListener("error", () => {
      onError(new DoorbellError("WS_ERROR", "Realtime WebSocket error."));
    });

    ws.addEventListener("close", () => {
      clearTimers();
      setJoined(false);
      scheduleReconnect();
    });
  }

  function waitUntilJoined(timeoutMs = 5000) {
    if (joined) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        joinWaiters = joinWaiters.filter(w => w.resolve !== done);
        reject(new DoorbellError("JOIN_TIMEOUT", "Timed out waiting for Realtime channel join."));
      }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      joinWaiters.push({ resolve: done });
    });
  }

  function publish(signal) {
    const clean = sanitizeSignal(signal);
    if (!joined) return { sent: false, reason: "not_joined", signal: clean };
    const ok = sendRaw({
      topic,
      event: "broadcast",
      payload: { type: "broadcast", event: BROADCAST_EVENT, payload: clean },
      ref: nextRef(),
      join_ref: joinRef,
    });
    return { sent: ok, signal: clean };
  }

  async function close() {
    closed = true;
    clearTimers();
    setJoined(false);
    joinWaiters = [];
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        ws.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.close();
      });
    }
  }

  return { connect, waitUntilJoined, publish, close, isJoined: () => joined };
}

module.exports = {
  ALLOWED_EVENTS,
  CHANNEL_TOPIC,
  BROADCAST_EVENT,
  DoorbellError,
  sanitizeSignal,
  toRealtimeWsUrl,
  createDoorbellClient,
};
