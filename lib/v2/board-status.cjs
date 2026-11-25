"use strict";

const { createCodexSheetTransport } = require("../codex-sheet-transport.cjs");

const TAB = "Tasks";
const HEADERS = ["id", "task", "to", "status", "order"];
const MAX_ROWS = 2000;
const MAX_COLUMNS = 26;
const MAX_WAITING_RESULTS = 25;
const BOARD = "(?:agent tasks(?: (?:sheet|board))?|(?:the |my |our )?(?:task )?board)";
const DIRECT_QUESTION = new RegExp([
  `^(?:what's|what is|what are) (?:next|open|pending|at hand|waiting|in progress|on|(?:the |my )?tasks) (?:on |in |from )?(?:the )?${BOARD}$`,
  `^(?:show|list|read|check) (?:me )?(?:(?:the |my )?(?:next|open|pending|current) tasks (?:on |in |from ))?(?:the )?${BOARD}$`,
  `^(?:what's|what is) (?:the )?status (?:of|on) (?:the )?${BOARD}$`,
  `^what tasks are at hand(?: (?:on|in) ${BOARD})?$`,
].join("|"));
const BOARD_CLARIFICATION = /^(?:i )?(?:i (?:mean|meant) (?:the )?)?agent tasks(?: (?:sheet|board))?(?: is what i (?:was asking about|meant))?$/;
const GENERAL_QUESTION = /^(?:what's|what is|what are) (?:next|open|pending|at hand|waiting|in progress|(?:the |my )?open tasks)$/;
const WAITING_QUESTION = "(?:which(?: (?:ones|tasks))?(?: are)?|what(?:'s| is|(?: tasks)? are)|(?:show|list)(?: me)?(?: (?:the )?tasks)?) waiting (?:on|for) (?:me|dom)";
const DIRECT_WAITING_QUESTION = new RegExp(`^${WAITING_QUESTION} (?:on|in|from) (?:the )?${BOARD}$`);
const WAITING_FOLLOWUP = new RegExp(`^(?:and )?${WAITING_QUESTION}$`);

function normalizeQuestion(content) {
  return String(content || "").toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim()
    .replace(/[?!.]+$/, "").replace(/^please | please$/g, "");
}

function boardQuestionIntent(thread) {
  let previous = "";
  let intent = null;
  for (const message of thread || []) {
    if (message.role !== "owner" && message.role !== "user") continue;
    const question = normalizeQuestion(message.content);
    if (DIRECT_WAITING_QUESTION.test(question) || (intent && WAITING_FOLLOWUP.test(question))) {
      intent = "waiting_on_owner";
    } else if (DIRECT_QUESTION.test(question)
      || (BOARD_CLARIFICATION.test(question) && (intent || GENERAL_QUESTION.test(previous)))) {
      intent = "overview";
    } else {
      intent = null;
    }
    previous = question;
  }
  return intent;
}

function cleanCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function taskSummary(task) {
  const description = task.title.length <= 145 ? task.title : `${task.title.slice(0, 142)}…`;
  const order = Number.isFinite(task.order) ? `, order ${task.order}` : "";
  return `${task.id} · ${task.assignee} · ${description} (${task.status}${order})`;
}

async function readBoardStatus({ boardId, callGoogleDrive, intent = "overview" } = {}) {
  if (!boardId) {
    throw Object.assign(new Error("Agent Tasks isn’t connected here."), { code: "BOARD_NOT_CONFIGURED" });
  }
  const sheet = createCodexSheetTransport({ boardId }, callGoogleDrive);
  const metadata = await sheet.getMetadata();
  const taskSheet = metadata.sheets?.find(tab => tab.properties?.title === TAB)?.properties;
  const rowCount = Math.min(Number(taskSheet?.gridProperties?.rowCount) || 0, MAX_ROWS);
  const columnCount = Math.min(Number(taskSheet?.gridProperties?.columnCount) || 0, MAX_COLUMNS);
  if (!rowCount || !columnCount) throw new Error("I couldn’t find the Tasks tab on the connected Agent Tasks board.");

  const [header] = await sheet.readRange(TAB, `A1:${String.fromCharCode(64 + columnCount)}1`);
  const normalized = (header || []).map(cell => cleanCell(cell).toLowerCase());
  const indices = HEADERS.map(headerName => normalized.indexOf(headerName));
  if (indices.includes(-1)) {
    throw new Error("The Agent Tasks header is missing ID, Task, To, Status, or Order.");
  }

  // Fetch just the five columns needed for the answer. Latest notes and other board
  // fields stay out of this read, and empty cell placeholders preserve row alignment.
  const columns = rowCount === 1 ? indices.map(() => []) : await Promise.all(indices.map(index => {
    const letter = String.fromCharCode(65 + index);
    return sheet.readRange(TAB, `${letter}2:${letter}${rowCount}`);
  }));
  const [idColumn] = columns;
  const tasks = idColumn.map((_, i) => {
    const [id, title, assignee, status, priority] = columns.map(column => cleanCell(column[i]?.[0]));
    const order = priority && Number(priority) > 0 ? Number(priority) : Infinity;
    return { id, title, assignee: assignee || "Unassigned", status, order };
  }).filter(task => /^P\d+$/i.test(task.id) && task.title);

  const ready = tasks.filter(task => /^(open|in progress)$/i.test(task.status));
  const waiting = tasks.filter(task => /^waiting on dom$/i.test(task.status));
  const scope = taskSheet.gridProperties.rowCount > MAX_ROWS ? `Read the first ${MAX_ROWS.toLocaleString("en-US")} rows of the Tasks tab.` : "";
  if (intent === "waiting_on_owner") {
    const count = waiting.length;
    const counts = count === 1 ? "Agent Tasks has 1 task waiting on you." : `Agent Tasks has ${count} tasks waiting on you.`;
    const list = waiting.slice(0, MAX_WAITING_RESULTS).map(task => `• ${taskSummary(task)}`).join("\n");
    const more = count > MAX_WAITING_RESULTS ? `Showing the first ${MAX_WAITING_RESULTS} in board order.` : "";
    return [counts, list, more, scope].filter(Boolean).join("\n\n");
  }
  const counts = `Agent Tasks has ${ready.length} open or in progress and ${waiting.length} waiting on Dom.`;
  const nextByAssignee = new Map();
  for (const task of ready) {
    const key = task.assignee.toLowerCase();
    if (!nextByAssignee.has(key) || task.order < nextByAssignee.get(key).order) nextByAssignee.set(key, task);
  }
  const preview = [...nextByAssignee.values()].slice(0, 5).map(task => `• ${taskSummary(task)}`);
  const remaining = nextByAssignee.size - preview.length;
  const next = preview.length ? ["Next by assignee", ...preview, remaining ? `And ${remaining} more assignees.` : ""].filter(Boolean).join("\n") : "";
  return [counts, next, scope].filter(Boolean).join("\n\n");
}

module.exports = { boardQuestionIntent, readBoardStatus };
