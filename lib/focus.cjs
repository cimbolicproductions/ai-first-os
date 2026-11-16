"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const RECENT_FINISH_MS = 10 * 60 * 1000;
const time = at => Date.parse(at || "") || 0;
const progressAt = (row, taskMeta) => taskMeta[row.ID]?.progress?.at(-1)?.at || row.Updated;
const visible = (row, taskMeta) => !taskMeta[row.ID]?.putAway;

function waitingForOwner({ tasks, taskMeta, notices, exclude = null }) {
  const noticesByRow = new Map();
  for (const notice of notices) {
    if (!notice.row || notice.answer || notice.kind === "done" || !(notice.reply || notice.kind === "approval" || notice.choices?.length || notice.form || notice.link)) continue;
    const at = time(notice.created);
    const earlier = noticesByRow.get(notice.row);
    if (earlier === undefined || at < earlier) noticesByRow.set(notice.row, at);
  }
  const waiting = [];
  for (const row of tasks) {
    if (row.ID === exclude || !visible(row, taskMeta)) continue;
    const at = noticesByRow.get(row.ID) ?? (
      taskMeta[row.ID]?.awaitingReply || row.Status === "Waiting on Dom" ? time(progressAt(row, taskMeta)) : null
    );
    if (at !== null) waiting.push({ id: row.ID, at });
  }
  return waiting.sort((a, b) => a.at - b.at).map(item => item.id);
}

const nextForOwner = options => waitingForOwner(options)[0] ?? null;

function pickFocus({ tasks, taskMeta, notices, saved, now = Date.now() }) {
  if (saved?.focus === null) return null;
  const available = tasks.filter(row => visible(row, taskMeta));
  const previous = available.find(row => row.ID === saved?.focus);
  if (previous) {
    const finished = taskMeta[previous.ID]?.progress?.findLast(event => event.stage === "completed")?.at || previous.Updated;
    if (previous.Status !== "Done" || now - time(finished) <= RECENT_FINISH_MS) return previous.ID;
  }
  const waiting = nextForOwner({ tasks: available, taskMeta, notices });
  const running = available.find(row => row.Status === "In progress");
  const stopped = available.filter(row => row.Status === "Waiting on User")
    .sort((a, b) => time(progressAt(b, taskMeta)) - time(progressAt(a, taskMeta)))[0];
  return waiting ?? running?.ID ?? stopped?.ID ?? available.find(row => row.Status === "Open")?.ID ?? null;
}

function readFocus(dir) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "ui.json"), "utf8"));
    if (saved && (saved.focus === null || typeof saved.focus === "string")) return saved;
  } catch (err) {
    if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
  }
  return undefined;
}

function writeFocus(dir, focus) {
  const file = path.join(dir, "ui.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ focus, at: new Date().toISOString() }) + "\n", "utf8");
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { nextForOwner, waitingForOwner, pickFocus, readFocus, writeFocus };
