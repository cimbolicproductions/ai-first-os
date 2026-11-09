"use strict";

const crypto = require("node:crypto");
const { answerNotice } = require("./os-runtime.cjs");
const { HARNESSES, labelFor } = require("./harness-registry.cjs");
const { buildDailySummary } = require("./daily-summary.cjs");
const { sendEmptyPush } = require("./web-push.cjs");

const HEARTBEAT_MS = 60000;
const ATTENTION_KINDS = new Set(["approval", "question", "blocked", "ide"]);

/**
 * The home machine's end of the phone connection. Each tick proves the computer
 * is alive, takes in anything that waited while it was away, and sends out
 * anything that could not be sent earlier. A notice stays marked unsent until the
 * relay accepts it, so an outage loses nothing.
 */
function createCloudLink({
  relayUrl,
  homeToken,
  board,
  notices,
  manifest,
  machine = "home",
  saveManifest = () => {},
  getAvailability = () => ({}),
  fetchFn = fetch,
  vapid = null,
  now = () => new Date(),
  onChange = () => {},
  onError = () => {},
}) {
  const base = relayUrl.replace(/\/$/, "");
  let online = false;
  let timer = null;
  let ticking = false;
  let again = false;

  async function call(method, route, body) {
    const res = await fetchFn(`${base}/v1/${route}`, {
      method,
      headers: { authorization: `Bearer ${homeToken}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw Object.assign(new Error(data.message || `Relay answered ${res.status}`), { code: data.code || "RELAY_ERROR" });
    }
    return data;
  }

  function alreadyTaken(requestId) {
    return board.listTasks().some(row => board.getMeta(row.ID).sourceRequest === requestId);
  }

  function takeRequest(item) {
    if (alreadyTaken(item.id)) return;
    const to = item.body.to || manifest.roles?.orchestrator || manifest.roles?.builder || "claude";
    board.addTask({
      task: item.body.text,
      to,
      from: "Phone",
      note: "Sent from your phone.",
      meta: { source: "phone", sourceRequest: item.id },
    });
  }

  function takeAnswer(item) {
    try {
      answerNotice({
        noticeId: item.body.noticeId,
        value: item.body.value,
        digest: item.body.digest,
        source: "phone",
        notices,
        board,
        manifest,
        saveManifest,
        availability: getAvailability(),
      });
    } catch (err) {
      onError(err);
    }
  }

  async function pushUnsent() {
    const unsent = notices.listAll().filter(n => !n.synced);
    let needsAlert = false;
    const sent = [];
    for (const n of unsent) {
      if (n.answer || notices.isExpired(n)) {
        await call("POST", "resolve", { noticeIds: [n.id] });
      } else {
        await call("POST", "notice", {
          notice: { id: n.id, row: n.row, kind: n.kind, text: n.text, choices: n.choices, digest: n.digest, created: n.created },
        });
        if (ATTENTION_KINDS.has(n.kind) || n.choices.length) needsAlert = true;
      }
      sent.push(n.id);
    }
    if (sent.length) notices.markSynced(sent);
    return needsAlert;
  }

  function agentsForPhone() {
    const availability = getAvailability();
    return HARNESSES.filter(h => availability[h.id]).map(h => ({ id: h.id, label: labelFor(h.id) }));
  }

  function raiseMorningSummary() {
    const cfg = manifest.summary;
    if (!cfg?.morningPush) return;
    const at = new Date(now());
    const today = at.toISOString().slice(0, 10);
    if (at.getHours() < (cfg.hour ?? 8) || cfg.lastSent === today) return;
    const yesterday = new Date(at.getTime() - 86400000);
    notices.raise({ kind: "summary", text: buildDailySummary({ board, notices, now: () => yesterday }).headline });
    cfg.lastSent = today;
    saveManifest(manifest);
  }

  async function tick() {
    if (ticking) {
      again = true;
      return online;
    }
    ticking = true;
    try {
      do {
        again = false;
        raiseMorningSummary();
        await call("POST", "heartbeat", {
          machine,
          summary: buildDailySummary({ board, notices, now }),
          agents: agentsForPhone(),
          vapidKey: vapid?.publicKey || null,
        });
        const { items, push } = await call("GET", "pull");
        for (const item of items) {
          if (item.kind === "request") takeRequest(item);
          else if (item.kind === "answer") takeAnswer(item);
        }
        if (items.length) await call("POST", "ack", { ids: items.map(i => i.id) });
        const alert = await pushUnsent();
        if (alert && vapid) {
          await Promise.allSettled(push.map(endpoint => sendEmptyPush({ endpoint, vapid, fetchFn })));
        }
        if (!online) {
          online = true;
          onChange(true);
        }
      } while (again);
    } catch (err) {
      if (online) {
        online = false;
        onChange(false);
      }
      onError(err);
    } finally {
      ticking = false;
    }
    return online;
  }

  function start({ intervalMs = HEARTBEAT_MS } = {}) {
    timer = setInterval(() => tick().catch(onError), intervalMs);
    tick().catch(onError);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, isOnline: () => online };
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/** The address goes in the fragment so it never reaches any server's logs. */
function buildPhoneLink({ pageUrl, relayUrl, phoneToken }) {
  const fragment = new URLSearchParams({ b: relayUrl, k: phoneToken }).toString();
  return `${pageUrl.replace(/#.*$/, "")}#${fragment}`;
}

module.exports = { createCloudLink, newToken, buildPhoneLink, HEARTBEAT_MS };
