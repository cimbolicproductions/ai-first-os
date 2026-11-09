"use strict";

const { labelFor } = require("./harness-registry.cjs");

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function buildDailySummary({ board, notices = null, now = () => new Date() }) {
  const day = new Date(now()).toISOString().slice(0, 10);
  const todays = board.listActivity().filter(e => e.at.slice(0, 10) === day);

  const latest = new Map();
  const started = new Set();
  for (const entry of todays) {
    latest.set(entry.row, entry);
    if (entry.type === "started") started.add(entry.row);
  }

  const finished = [];
  const undo = [];
  for (const entry of latest.values()) {
    if (entry.type === "Done") {
      finished.push({ row: entry.row, task: entry.task, by: labelFor(entry.to) });
      undo.push({ row: entry.row, action: "reopen", label: "Put back on the board" });
    } else if (entry.type === "queued") {
      undo.push({ row: entry.row, action: "withdraw", label: "Take it back" });
    }
  }

  const waiting = (notices ? notices.listOpen() : [])
    .filter(n => ["approval", "question", "blocked", "ide"].includes(n.kind))
    .map(n => ({ row: n.row, text: n.text, noticeId: n.id }));

  const parts = [];
  if (started.size) parts.push(`Your agents worked on ${plural(started.size, "thing", "things")} today.`);
  if (finished.length) parts.push(`${plural(finished.length, "is", "are")} finished.`.replace(/^(\d+) (is|are)/, (_, n, verb) => `${n} ${verb}`));
  if (waiting.length) parts.push(`${waiting.length} ${waiting.length === 1 ? "is" : "are"} waiting on you.`);
  const headline = parts.length ? parts.join(" ") : "Nothing has run yet today.";

  return {
    date: day,
    headline,
    ran: [...started],
    finished,
    waiting,
    undo,
  };
}

/** Undo exists for board state only. It never claims to reverse finished work. */
function applyUndo({ board, row, action, routerName = "Router" }) {
  const current = board.findTask(row);
  if (!current) throw Object.assign(new Error(`Task "${row}" not found`), { code: "TASK_MISSING" });
  if (action === "reopen" && current.Status === "Done") {
    const meta = board.getMeta(row);
    return board.updateByColumnName({
      taskId: row,
      agent: routerName,
      columns: { Status: "Open", To: meta.builder || current.To },
      note: "Put back on the board. Anything it already changed stays changed.",
    });
  }
  if (action === "withdraw" && current.Status === "Open") {
    const done = board.updateByColumnName({ taskId: row, agent: routerName, columns: { Status: "Done" }, note: "Taken back before it started." });
    board.logActivity({ type: "withdrawn", row, to: routerName, task: current.Task });
    return done;
  }
  throw Object.assign(new Error("That cannot be undone now."), { code: "CANNOT_UNDO" });
}

module.exports = { buildDailySummary, applyUndo };
