"use strict";

const { randomUUID } = require("node:crypto");
const { createSheetTasks } = require("./sheet-tasks.cjs");
const { labelFor } = require("./harness-registry.cjs");
const { canonicalId, DEFAULT_SLATE } = require("./roles.cjs");

const RESULT_STATES = new Set(["completed", "blocked", "needs_input", "failed", "clarify", "delegate", "tasks", "approval_required"]);
const WORKER_ROLES = ["builder", "auditor", "researcher"];
const MAX_SPLIT_TASKS = 8;
function sheetTaskCommand(task) {
  const text = String(task).trim().replace(/^(?:hey muse[,!]?\s+)?(?:please\s+)?/i, "");
  const add = /^(?:add|save|log) (?:(?:a|this|these|my) )?tasks?(?: to the sheet)?(?:\s*:\s*| to |\s+)([\s\S]+)$/i.exec(text);
  if (add) {
    const tasks = add[1].split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
    if (tasks.length) return { kind: "add", tasks };
  }
  const mark = /^mark (P[1-9]\d*) (?:as )?(done|open|in progress|waiting on dom)[.!]?$/i.exec(text);
  if (mark) {
    const statuses = { done: "Done", open: "Open", "in progress": "In progress", "waiting on dom": "Waiting on Dom" };
    return { kind: "update", id: mark[1].toUpperCase(), status: statuses[mark[2].toLowerCase()] };
  }
  return null;
}

/** Classify explicit requests conservatively. The ambiguous path is read-only. */
function classifyOrganizerRequest(task) {
  if (sheetTaskCommand(task)) return "sheet_task";
  const text = String(task).trim().replace(/^(?:hey muse[,!]?\s+)?(?:please\s+|(?:can|could|would) you\s+)*/i, "");
  const external = /(?:^|[.!?;\n]\s*|\b(?:and|then)\s+)(?:please\s+)?(?:send\b|email\b|text\b|message\b|publish\b|submit\b|refund\b|buy\b|purchase\b|pay\b|spend\b|charge\b|deploy\b|push (?:to|the branch|the code)\b)/i;
  if (external.test(text)) return "external_action";
  const question = text
    .replace(/[?.!]+$/, "")
    .replace(/ (?:right now|now)$/i, "")
    .replace(/ (?:on|in|from) (?:the |my )?(?:board|local (?:tasks|board)|agent tasks(?: sheet)?|google (?:sheet|sheets))$/i, "")
    .replace(/ (?:right now|now)$/i, "")
    .replace(/^show me (?=what )/i, "");
  const asksStatus = /^(?:what(?:['’]s| is| are) (?:open|(?:my |the )?(?:open |pending |active )?tasks)|what tasks (?:are open|are pending|are active|are at hand|are on my list|do i have(?: open)?))$/i.test(question);
  const asksList = /^(?:show|list) (?:me )?(?:(?:my|the|all) )?(?:open |pending |active |queued |outstanding )?tasks$/i.test(question);
  if (asksStatus || asksList) return "status_question";
  if (/^(?:(?:help me |let's )?(?:plan|brainstorm|outline|prioritize)\b|make (?:me )?a plan\b|how (?:do|would|could|should) (?:i|we|you)\b)/i.test(text)) return "planning";
  if (/^(?:research|investigate|compare|look up|find out|fact[- ]check)\b/i.test(text)) return "research";
  if (/^(?:review|audit|verify|check)\s+(?:(?:the|this|my|our)\s+)?(?:code|patch|diff|pull request|changes|implementation|security)\b/i.test(text)) return "review";
  if (/^(?:fix|implement|refactor|debug|patch|write code|build (?:an? |the )?(?:app|site|component|feature)|(?:add|change|update|remove|create|rename|edit)\s+.*\b(?:code|test|api|ui|feature|component|function|button|style|bug|script|endpoint|workflow|repo|settings|file|folder|document|note|readme|login)\b)/i.test(text)) return "coding";
  return "general_question";
}

function progressEvent(stage, agent = null) {
  return { stage, at: new Date().toISOString(), ...(agent ? { agent } : {}) };
}

function queueOrganizerRequest({ task, board, manifest, source, sourceRequest }) {
  if (typeof task !== "string" || !task.trim() || task.length > 16000) {
    throw Object.assign(new Error("Enter a request of up to 16,000 characters."), { code: "INVALID_TASK" });
  }
  const intent = classifyOrganizerRequest(task);
  const organizer = manifest.roles?.orchestrator || manifest.ideology?.routerFunnel || DEFAULT_SLATE.orchestrator;
  const requestedAgent = canonicalId(organizer);
  return board.addTask({
    task,
    to: requestedAgent,
    from: source === "phone" ? "Phone" : "You",
    note: source === "phone" ? "Sent from your phone." : "Request queued.",
    meta: {
      intent, role: "orchestrator", kind: "organize", requestedAgent, musePhase: "organize", progress: [progressEvent("queued")],
      ...(intent === "sheet_task" ? { sheetRequestId: randomUUID() } : {}),
      ...(source ? { source, sourceRequest } : {}),
    },
  });
}

async function summarizeOpenTasks({ board, manifest, requestId, task, makeSheetTasks = createSheetTasks }) {
  const namedSheet = /\b(?:on|in|from) (?:the |my )?(?:agent tasks|google (?:sheet|sheets))\b/i.test(task);
  const namedLocal = /\b(?:on|in|from) (?:the |my )?local (?:tasks|board)\b/i.test(task);
  const sheet = namedSheet || (!namedLocal && manifest.board?.mode === "sheets");
  const label = sheet ? "Connected Google Sheet" : "Local tasks";
  let rows;
  try {
    if (sheet) {
      const sheetTasks = makeSheetTasks({ manifest });
      if (!sheetTasks.configured) throw new Error("Missing board configuration");
      const openTasks = await sheetTasks.listOpen();
      rows = openTasks.map(row => ({ ID: row.id, Task: row.task, To: row.to, Status: row.status }));
    } else {
      rows = board.listTasks().filter(row => row.ID !== requestId);
    }
  } catch {
    return { status: "Waiting on User", answer: sheet
      ? "I can’t read that Google Sheet. Connect it with read-only access, or ask for your local tasks."
      : "I can’t read your local task board. Try again when it’s available." };
  }

  const open = rows.filter(row => row.Task && /^(open|in progress|waiting on (?:user|dom))$/i.test(row.Status));
  if (!open.length) return { status: "Done", answer: label + "\nNone currently. Want to add a task?" };
  const statuses = { open: "Queued", "in progress": "Working", "waiting on user": "Needs you", "waiting on dom": "Needs you" };
  const lines = open.slice(0, 50).map(row => {
    const title = String(row.Task).replace(/\s+/g, " ").trim();
    const owner = row.To ? " · " + labelFor(row.To) : "";
    return `• ${row.ID ? row.ID + " " : ""}${title.length > 140 ? title.slice(0, 137) + "…" : title} · ${statuses[row.Status.toLowerCase()]}${owner}`;
  });
  const extra = open.length > lines.length ? `\n${open.length - lines.length} more on the board.` : "";
  return { status: "Done", answer: label + "\n" + lines.join("\n") + extra };
}

function parseRequestResult(stdout) {
  const lines = String(stdout || "").trimEnd().split(/\r?\n/);
  if (lines.at(-1).trim() === "```") lines.pop();
  const line = lines.at(-1)?.trim() || "";
  if (!line.startsWith("AIOS-RESULT: ") || line.length > 12000) return null;
  let value;
  try { value = JSON.parse(line.slice("AIOS-RESULT: ".length)); } catch { return null; }
  if (!value || !RESULT_STATES.has(value.status) || typeof value.answer !== "string" || !value.answer.trim() || value.answer.length > 6000) return null;
  if (["needs_input", "clarify"].includes(value.status) && (typeof value.question !== "string" || !value.question.trim() || value.question.length > 1200)) return null;
  if (value.status === "delegate" &&
      (!["builder", "auditor", "researcher"].includes(value.role) || typeof value.work !== "string" ||
        !value.work.trim() || value.work.length > 6000)) return null;
  // A voice dump holds several jobs. Each one must be a real, scoped task or the whole reply is refused.
  if (value.status === "tasks" &&
      (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > MAX_SPLIT_TASKS ||
        value.tasks.some(item => !item || !WORKER_ROLES.includes(item.role) || typeof item.work !== "string" ||
          !item.work.trim() || item.work.length > 2000))) return null;
  return {
    status: value.status === "completed" ? "Done" : "Waiting on User",
    answer: value.answer.trim(),
    result: value.status,
    ...(value.status === "tasks" ? { split: value.tasks.map(item => ({ role: item.role, work: item.work.trim() })) } : {}),
    ...(value.status === "needs_input" ? { ask: value.question.trim() } : {}),
    ...(value.status === "clarify" ? { question: value.question.trim() } : {}),
    ...(value.status === "delegate" ? { delegation: { role: value.role, work: value.work.trim() } } : {}),
  };
}

function replyToOrganizer({ taskId, text, turn, board, manifest }) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000 || !Number.isSafeInteger(turn)) {
    throw Object.assign(new Error("Enter a reply of up to 4,000 characters."), { code: "INVALID_REPLY" });
  }
  const meta = board.getMeta(taskId);
  const conversation = meta.conversation || [];
  if (!meta.awaitingReply || conversation.length !== turn) {
    throw Object.assign(new Error("This question has changed. Check the latest reply."), { code: "STALE_REPLY" });
  }
  return board.updateByColumnName({
    taskId, expectedReplyTurn: turn, agent: manifest.ideology?.routerFunnel || "Muse",
    columns: { Status: "Open", To: meta.requestedAgent },
    meta: {
      awaitingReply: false, answer: null, executor: null,
      conversation: [...conversation, { role: "user", text: text.trim() }],
      progress: [...(meta.progress || []), progressEvent("queued")].slice(-16),
    },
  });
}

module.exports = { sheetTaskCommand, classifyOrganizerRequest, progressEvent, queueOrganizerRequest, replyToOrganizer, summarizeOpenTasks, parseRequestResult };
