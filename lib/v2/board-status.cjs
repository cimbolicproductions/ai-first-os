"use strict";

const { createCodexSheetTransport } = require("../codex-sheet-transport.cjs");

const TAB = "Tasks";
const HEADERS = ["id", "task", "to", "status", "order"];
const MAX_ROWS = 2000;
const MAX_COLUMNS = 26;
const BOARD = "(?:agent tasks(?: (?:sheet|board))?|(?:the |my |our )?(?:task )?board)";
const DIRECT_QUESTION = new RegExp([
  `^(?:what's|what is|what are) (?:next|open|pending|at hand|waiting|in progress|on|(?:the |my )?tasks) (?:on |in |from )?(?:the )?${BOARD}$`,
  `^(?:show|list|read|check) (?:me )?(?:(?:the |my )?(?:next|open|pending|current) tasks (?:on |in |from ))?(?:the )?${BOARD}$`,
  `^(?:what's|what is) (?:the )?status (?:of|on) (?:the )?${BOARD}$`,
  `^what tasks are at hand(?: (?:on|in) ${BOARD})?$`,
].join("|"));
const BOARD_CLARIFICATION = /^(?:i )?(?:i (?:mean|meant) (?:the )?)?agent tasks(?: (?:sheet|board))?(?: is what i (?:was asking about|meant))?$/;
const GENERAL_QUESTION = /^(?:what's|what is|what are) (?:next|open|pending|at hand|waiting|in progress|(?:the |my )?open tasks)$/;

function normalizeQuestion(content) {
  return String(content || "").toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim()
    .replace(/[?!.]+$/, "").replace(/^please | please$/g, "");
}

function matchBoardQuestion(thread) {
  const owner = (thread || []).filter(message => message.role === "owner" || message.role === "user");
  const last = normalizeQuestion(owner.at(-1)?.content);
  if (DIRECT_QUESTION.test(last)) return true;
  if (!BOARD_CLARIFICATION.test(last)) return false;
  const previous = normalizeQuestion(owner.at(-2)?.content);
  return DIRECT_QUESTION.test(previous) || GENERAL_QUESTION.test(previous);
}

function cleanCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function taskSummary(task) {
  const description = task.title.length <= 145 ? task.title : `${task.title.slice(0, 142)}…`;
  const order = Number.isFinite(task.order) ? `, order ${task.order}` : "";
  return `${task.id} · ${task.assignee} · ${description} (${task.status}${order})`;
}

async function readBoardStatus({ boardId, callGoogleDrive } = {}) {
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
  if (rowCount === 1) return "Agent Tasks has no open or in-progress tasks.";

  // Fetch just the five columns needed for the answer. Latest notes and other board
  // fields stay out of this read, and empty cell placeholders preserve row alignment.
  const columns = await Promise.all(indices.map(index => {
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
  const counts = `Agent Tasks has ${ready.length} open or in progress and ${waiting.length} waiting on Dom.`;
  const nextByAssignee = new Map();
  for (const task of ready) {
    const key = task.assignee.toLowerCase();
    if (!nextByAssignee.has(key) || task.order < nextByAssignee.get(key).order) nextByAssignee.set(key, task);
  }
  const preview = [...nextByAssignee.values()].slice(0, 5).map(task => `• ${taskSummary(task)}`);
  const remaining = nextByAssignee.size - preview.length;
  const scope = taskSheet.gridProperties.rowCount > MAX_ROWS ? `Read the first ${MAX_ROWS.toLocaleString("en-US")} rows of the Tasks tab.` : "";
  const next = preview.length ? ["Next by assignee", ...preview, remaining ? `And ${remaining} more assignees.` : ""].filter(Boolean).join("\n") : "";
  return [counts, next, scope].filter(Boolean).join("\n\n");
}

module.exports = { matchBoardQuestion, readBoardStatus };
