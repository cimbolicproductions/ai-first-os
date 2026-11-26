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

const TASK_LOOKUP = /^(?:and |(?:can|could|would) you )?(?:(?:what is|what's|what about|tell me about|show(?: me)?|look up|find|i (?:asked|meant to ask) about) (?:(?:the )?(?:status of|latest on) )?(?:task )?)?(p\d+)(?: on agent tasks)?$/;

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

function boardTaskLookupId(content) {
  return TASK_LOOKUP.exec(normalizeQuestion(content))?.[1].toUpperCase() ?? null;
}

function cleanCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function taskSummary(task) {
  const description = task.title.length <= 145 ? task.title : `${task.title.slice(0, 142)}…`;
  const order = Number.isFinite(task.order) ? `, order ${task.order}` : "";
  return `${task.id} · ${task.assignee} · ${description} (${task.status}${order})`;
}

function openBoard(boardId, callGoogleDrive) {
  if (!boardId) {
    throw Object.assign(new Error("Agent Tasks isn’t connected here."), { code: "BOARD_NOT_CONFIGURED" });
  }
  return createCodexSheetTransport({ boardId }, callGoogleDrive);
}

const columnLetter = index => String.fromCharCode(65 + index);

async function readTabLayout(sheet, tab, fields) {
  const { title, gridProperties } = tab;
  const rowCount = Math.min(Number(gridProperties?.rowCount) || 0, MAX_ROWS);
  const columnCount = Math.min(Number(gridProperties?.columnCount) || 0, MAX_COLUMNS);
  if (!rowCount || !columnCount) throw new Error("The Agent Tasks tab has no readable grid.");
  const [header] = await sheet.readRange(title, `A1:${columnLetter(columnCount - 1)}1`);
  const normalized = (header || []).map(cell => cleanCell(cell).toLowerCase());
  const indices = fields.map(field => normalized.indexOf(field));
  if (indices.includes(-1)) throw new Error("The Agent Tasks tab is missing a required header.");
  return { rowCount, indices, limited: gridProperties.rowCount > MAX_ROWS };
}

async function readTaskMatches(sheet, tab, taskId) {
  const { rowCount, indices, limited } = await readTabLayout(sheet, tab, HEADERS.slice(0, 4));
  if (rowCount < 2) return { matches: [], limited };

  const idLetter = columnLetter(indices[0]);
  const ids = await sheet.readRange(tab.title, `${idLetter}2:${idLetter}${rowCount}`);
  const matchingRows = ids.flatMap((row, i) => cleanCell(row?.[0]).toUpperCase() === taskId ? [i + 2] : []);
  const firstColumn = Math.min(...indices);
  const lastColumn = Math.max(...indices);
  const matches = await Promise.all(matchingRows.map(async number => {
    const [row] = await sheet.readRange(tab.title, `${columnLetter(firstColumn)}${number}:${columnLetter(lastColumn)}${number}`);
    const [id, title, assignee, status] = indices.map(index => cleanCell(row?.[index - firstColumn]));
    if (id.toUpperCase() !== taskId) throw new Error("The Agent Tasks row moved during lookup.");
    return { title, assignee, status, tab: tab.title, number };
  }));
  return { matches, limited };
}

async function readBoardTask({ boardId, callGoogleDrive, taskId }) {
  const sheet = openBoard(boardId, callGoogleDrive);
  const metadata = await sheet.getMetadata();
  const tabs = (metadata.sheets || []).map(tab => tab.properties)
    .filter(tab => [TAB, "Done"].includes(tab?.title));
  if (!tabs.some(tab => tab.title === TAB)) throw new Error("The connected board has no Tasks tab.");

  const results = await Promise.all(tabs.map(tab => readTaskMatches(sheet, tab, taskId)));
  const matches = results.flatMap(result => result.matches);
  if (!matches.length) {
    const scope = results.some(result => result.limited)
      ? `I checked up to ${MAX_ROWS.toLocaleString("en-US")} rows per tab.`
      : `I checked ${tabs.map(tab => tab.title).join(" and ")}.`;
    return `I couldn’t find ${taskId} on Agent Tasks. ${scope}`;
  }
  if (matches.length > 1) {
    const rows = matches.map(task => `• ${task.tab}, row ${task.number} · ${task.title || "Untitled task"}`);
    return [`I found ${matches.length} entries for ${taskId}. Which one did you mean?`, ...rows].join("\n");
  }
  const { title, assignee, status, tab } = matches[0];
  const assigned = assignee ? `${taskId} is assigned to ${assignee}.` : `${taskId} has no assignee.`;
  const currentStatus = status || (tab === "Done" ? "Done" : "");
  const progress = currentStatus ? `It’s marked “${currentStatus}.”` : "The board has no status for it.";
  return `${assigned} ${progress}\n${title || "Untitled task"}`;
}

async function readBoardStatus({ boardId, callGoogleDrive, intent = "overview" } = {}) {
  const sheet = openBoard(boardId, callGoogleDrive);
  const metadata = await sheet.getMetadata();
  const taskSheet = metadata.sheets?.find(tab => tab.properties?.title === TAB)?.properties;
  if (!taskSheet) throw new Error("The connected board has no Tasks tab.");
  const { rowCount, indices, limited } = await readTabLayout(sheet, taskSheet, HEADERS);

  // Fetch just the five columns needed for the answer. Latest notes and other board
  // fields stay out of this read, and empty cell placeholders preserve row alignment.
  const columns = rowCount === 1 ? indices.map(() => []) : await Promise.all(indices.map(index => {
    const letter = columnLetter(index);
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
  const scope = limited ? `Read the first ${MAX_ROWS.toLocaleString("en-US")} rows of the Tasks tab.` : "";
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

module.exports = { boardQuestionIntent, boardTaskLookupId, readBoardStatus, readBoardTask };
