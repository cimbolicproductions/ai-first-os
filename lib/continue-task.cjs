"use strict";

const { labelFor } = require("./harness-registry.cjs");
const { canonicalId, routeTask, roleOfAgent } = require("./roles.cjs");
const { progressEvent, replyToOrganizer } = require("./request-flow.cjs");

/**
 * Continue: one press to keep a request moving, without retyping it.
 *
 * - The organizer asked a question: it is told to go ahead and decide the rest, recorded as the owner's reply.
 * - It stopped, failed, was interrupted or found no agent: the same request, with what happened so far, goes to
 *   the next agent the owner picked, a different one from last time when there is one.
 * - It is running but has gone quiet: that one run is stopped first, then handed over the same way.
 * - Anything waiting on the owner's yes, no or choice is never continued here: only the owner answers that.
 */

const GO_AHEAD = "Go ahead. Make the remaining choices yourself and write down what you assumed.";
const QUIET_MS = 3 * 60 * 1000;
// Choices that only mean "run it again": Continue may stand in for those, and for nothing else.
const RETRY_CHOICE = /^(retry|install:)/;
const STEP_WORDS = {
  queued: "queued", delegated: "handed to a worker", fallback: "moved to another agent", retrying: "waited to retry",
  unavailable: "agent unavailable", failed: "failed", completed: "finished", waiting: "stopped to wait", continued: "continued",
};

function lastAgentOf(row, meta) {
  return canonicalId(meta.executor || meta.builder || row.To);
}

function roleOf(row, meta, manifest) {
  return meta.role || (meta.musePhase === "organize" ? "orchestrator" : roleOfAgent(canonicalId(row.To), manifest)) || "builder";
}

/** The owner's next pick for this kind of work, preferring someone other than whoever had it last. */
function nextAgent({ row, meta, manifest, availability }) {
  const role = roleOf(row, meta, manifest);
  const other = routeTask({ assigned: row.To, manifest, availability, exclude: [lastAgentOf(row, meta)], role }).agent;
  return other || routeTask({ assigned: row.To, manifest, availability, role }).agent;
}

/** What one press of Continue would do for this row right now. Shown before the press, so it never surprises. */
function continuePlan({ row, meta = {}, notices = [], manifest = {}, availability = {}, lastSeenAt = null, now = Date.now, statusOf = () => null }) {
  if (!row || row.Status === "Done" || meta.putAway === true || row.Status === "Open") return { action: "none" };
  // Waiting on a web lookup that is still going: it carries on by itself. If the lookup is stuck, Continue is offered there.
  const lookup = meta.waitingFor ? statusOf(meta.waitingFor) : null;
  if (lookup && lookup !== "Done") return { action: "none" };
  if (row.Status === "In progress") {
    const seen = Date.parse(lastSeenAt || "") || Date.parse(meta.startedAt || "") || 0;
    if (!seen || now() - seen < QUIET_MS) return { action: "none" };
    const to = nextAgent({ row, meta, manifest, availability });
    return to ? { action: "stop-and-handoff", to, quietMs: now() - seen } : { action: "none" };
  }
  const waiting = notices.filter(n => n.row === row.ID && !n.answer);
  const gate = waiting.find(n => n.kind === "approval" || (Array.isArray(n.choices) && n.choices.some(c => !RETRY_CHOICE.test(String(c?.value)))));
  if (gate) return { action: "wait", text: gate.text };
  if (meta.awaitingReply === true) return { action: "go-ahead" };
  const to = nextAgent({ row, meta, manifest, availability });
  return to ? { action: "handoff", to } : { action: "wait", text: "None of the agents you picked is free right now. Check Agents." };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clock = at => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(11, 16) + " UTC";
};

async function continueTask({
  board, manifest, notices, taskId, availability, lastSeenAt = null, router = "Router",
  now = Date.now, waitForStopMs = 25000, pollMs = 300, note = null,
}) {
  const row = board.findTask(taskId);
  if (!row) return { ok: false, message: "That request is no longer on the board." };
  let meta = board.getMeta(taskId);
  const plan = continuePlan({ row, meta, notices: notices.listOpen(), manifest, availability, lastSeenAt, now, statusOf: id => board.findTask(id)?.Status });

  if (note && plan.action !== "handoff") return { ok: false, message: "This request has moved on. Your note is still here." };
  if (plan.action === "go-ahead") {
    replyToOrganizer({ taskId, text: GO_AHEAD, turn: (meta.conversation || []).length, board, manifest, notices, source: "computer" });
    return { ok: true, action: "go-ahead", message: "Told it to go ahead and decide the rest." };
  }
  if (plan.action === "stop-and-handoff") {
    // Only this run stops. Its own stop check sees the request within a moment and ends the agent.
    board.setMeta(taskId, { stopRequestedAt: now() });
    const deadline = now() + waitForStopMs;
    while (board.findTask(taskId)?.Status === "In progress") {
      if (now() > deadline) return { ok: false, message: "It is still stopping. Press Continue again in a moment." };
      await sleep(pollMs);
    }
    meta = board.getMeta(taskId);
  } else if (plan.action !== "handoff") {
    return { ok: false, message: plan.text || "There is nothing to continue here." };
  }

  if (note) board.addOwnerNote(taskId, note, ["Waiting on User", "Waiting on Dom"]);
  const current = board.findTask(taskId);
  const last = lastAgentOf(current, meta);
  const steps = (meta.progress || []).slice(-6)
    .map(event => [clock(event.at), STEP_WORDS[event.stage] || event.stage, event.agent ? `(${labelFor(event.agent)})` : ""].filter(Boolean).join(" "));
  const lastNote = String(current["Latest note"] || "").split("\n").filter(line => !/\[RUN P\d+ /.test(line)).at(-1) || "";
  board.updateByColumnName({
    taskId, agent: router, columns: { Status: "Open", To: plan.to },
    note: `Owner pressed Continue: ${labelFor(last)} to ${labelFor(plan.to)}.`,
    meta: {
      continuation: {
        from: last, to: plan.to, at: new Date(now()).toISOString(),
        why: plan.action === "stop-and-handoff" ? "went quiet, so the owner stopped it" : "stopped without finishing",
        lastWords: [meta.answer, lastNote].filter(Boolean).join(" Last note on the board: ").slice(0, 1200) || null,
        steps,
      },
      answer: null, executor: null, retryAfter: null, autoRetries: 0, awaitingReply: false, stopRequestedAt: null, waitingFor: null,
      progress: [...(meta.progress || []), progressEvent("continued", plan.to)].slice(-16),
    },
  });
  // The "Try again" cards for this request are settled by the press.
  for (const notice of notices.listOpen()) {
    if (notice.row === taskId && !notice.answer) notices.recordAnswer(notice.id, "continued", "computer");
  }
  return { ok: true, action: "handoff", to: plan.to, message: `Handed to ${labelFor(plan.to)} with everything so far.` };
}

module.exports = { continuePlan, continueTask, GO_AHEAD, QUIET_MS };
