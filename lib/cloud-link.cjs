"use strict";

const crypto = require("node:crypto");
const { answerNotice } = require("./os-runtime.cjs");
const { classifyOrganizerRequest, queueOrganizerRequest } = require("./request-flow.cjs");
const { HARNESSES, labelFor } = require("./harness-registry.cjs");
const { buildDailySummary } = require("./daily-summary.cjs");
const { sendEmptyPush } = require("./web-push.cjs");
const { parseSheetOperation } = require("./relay-core.cjs");
const { createSheetTasks } = require("./sheet-tasks.cjs");
const { mirrorTarget } = require("./sheet-board.cjs");
const { addVersionNote } = require("./versions.cjs");

const HEARTBEAT_MS = 60000;
const SHEET_FAILURES = {
  SHEET_NOT_CONNECTED: "Connect your task sheet on the computer first.",
  SHEET_CONFLICT: "This task changed. Refresh the task list before updating it.",
  SHEET_TASK_MISSING: "This task is no longer open. Refresh the task list.",
  SHEET_INVALID_REQUEST: "Check the task details and try again.",
  SHEET_ID_COLLISION: "Task IDs collided. Check the task sheet before saving again.",
  SHEET_HEADERS: "The task sheet columns changed. Check the task sheet on your computer.",
};
const ATTENTION_KINDS = new Set(["approval", "question", "blocked", "ide", "connect"]);

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
  makeSheetTasks = createSheetTasks,
  addNote = addVersionNote,
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

  /**
   * "Note for P12: make the header blue". A note on a finished build goes into its next
   * version, the same as a note typed on the computer. It travels as an ordinary request,
   * so the phone link needs nothing new. Anything that is not a note falls through.
   */
  function takeNote(item) {
    const said = /^note for (P[1-9]\d{0,6}):\s*([\s\S]+)$/i.exec(String(item.body.text || "").trim());
    if (!said) return false;
    const rowId = said[1].toUpperCase();
    try {
      const noted = addNote({ board, rowId, text: said[2] });
      // Remembered against the request, so the same message is never taken twice.
      board.setMeta(noted.root, { phoneNotes: [...(board.getMeta(noted.root).phoneNotes || []), item.id].slice(-50) });
      notices.raise({ row: noted.root, kind: "done", text: noted.started
        ? `Your note is in. Version ${noted.started.version} of ${noted.root} is being built with it.`
        : `Your note is saved for the next version of ${noted.root}.` });
      return true;
    } catch {
      return false;
    }
  }

  function takeRequest(item) {
    if (alreadyTaken(item.id)) return;
    if (board.listTasks().some(row => (board.getMeta(row.ID).phoneNotes || []).includes(item.id))) return;
    if (takeNote(item)) return;
    const { text: task, to } = item.body;
    if (!to || classifyOrganizerRequest(task) === "external_action") {
      queueOrganizerRequest({ task, board, manifest, source: "phone", sourceRequest: item.id });
      return;
    }
    board.addTask({
      task,
      to,
      from: "Phone",
      note: "Sent from your phone.",
      meta: { source: "phone", sourceRequest: item.id },
    });
  }

  async function takeSheetRequest(item, sheets) {
    const operation = parseSheetOperation(item.body);
    if (!operation) {
      onError(new Error("Invalid queued Sheet operation"));
      return true;
    }
    const { action, requestId } = operation;
    let receipt;
    try {
      if (!sheets.configured) throw Object.assign(new Error("Sheet is not configured"), { code: "SHEET_NOT_CONNECTED" });
      if (action === "list") {
        const tasks = await sheets.listOpen();
        const message = tasks.length ? `${tasks.length} open ${tasks.length === 1 ? "task" : "tasks"}.`
          : "None currently. Did you want to add tasks?";
        receipt = { success: true, message, tasks };
      } else if (action === "add") {
        const tasks = await sheets.add({ tasks: operation.tasks, requestId, source: "phone" });
        receipt = { success: true, message: `Saved ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} to your Sheet.`, tasks };
      } else {
        const { id, task, status, revision } = operation;
        const updated = await sheets.update({ id, task, status, revision, requestId, source: "phone" });
        receipt = { success: true, message: `Saved ${updated.id} to your Sheet.`, tasks: [updated] };
      }
    } catch (err) {
      onError(err);
      // The Sheet may already have accepted the write. Retry this same request ID.
      if (err.code === "SHEET_UNCONFIRMED") return false;
      receipt = { success: false, message: SHEET_FAILURES[err.code] || "Could not reach your task sheet. Check the connection on your computer." };
    }
    await call("POST", "receipt", { requestId, ...receipt });
    return true;
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
          notice: { id: n.id, row: n.row, kind: n.kind, text: n.text, choices: n.choices, digest: n.digest, created: n.created, ...(n.link ? { link: n.link } : {}), ...(n.linkLabel ? { linkLabel: n.linkLabel } : {}) },
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
        const sheets = makeSheetTasks({ manifest });
        await call("POST", "heartbeat", {
          machine,
          summary: buildDailySummary({ board, notices, now }),
          agents: agentsForPhone(),
          vapidKey: vapid?.publicKey || null,
          sheetTasks: sheets.configured && !mirrorTarget(manifest),
        });
        const { items, push } = await call("GET", "pull");
        const accepted = [];
        for (const item of items.slice(0, 200)) {
          if (item.kind === "sheet" && !(await takeSheetRequest(item, sheets))) continue;
          if (item.kind === "request") takeRequest(item);
          else if (item.kind === "answer") takeAnswer(item);
          accepted.push(item.id);
        }
        if (accepted.length) await call("POST", "ack", { ids: accepted });
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
