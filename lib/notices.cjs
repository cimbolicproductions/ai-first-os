"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const APPROVAL_LIFETIME_MS = 72 * 3600 * 1000;

/**
 * Every moment the OS needs a person, or wants to tell them something, is one
 * notice in plain words. Desktop, terminal and phone all read this same book, so
 * a question answered anywhere is answered everywhere.
 */
function digestOf({ id, row, kind, text, choices }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([id, row || "", kind, text, (choices || []).map(c => c.value)]))
    .digest("hex")
    .slice(0, 32);
}

function createNoticeBook({ dir, now = () => new Date() }) {
  const file = path.join(path.resolve(dir), "notices.json");

  function read() {
    if (!fs.existsSync(file)) return { version: 1, next: 1, items: [] };
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  }

  function raise({ row = null, kind, text, choices = [], agent = null, settingKey = null, then = null, link = null, linkLabel = null, form = null }) {
    const state = read();
    const duplicate = state.items.find(n => !n.answer && n.row === row && n.kind === kind && n.text === text);
    if (duplicate) return structuredClone(duplicate);
    const created = new Date(now());
    const notice = {
      id: `N${state.next++}`,
      row,
      kind,
      text,
      choices,
      agent,
      settingKey,
      then,
      ...(link ? { link } : {}),
      ...(link && linkLabel ? { linkLabel } : {}),
      ...(form ? { form } : {}),
      created: created.toISOString(),
      expires: new Date(created.getTime() + APPROVAL_LIFETIME_MS).toISOString(),
      synced: false,
      answer: null,
    };
    notice.digest = digestOf(notice);
    state.items.push(notice);
    write(state);
    return structuredClone(notice);
  }

  function isExpired(notice) {
    return new Date(now()).getTime() > new Date(notice.expires).getTime();
  }

  function listOpen() {
    return read().items.filter(n => !n.answer && !isExpired(n)).map(n => structuredClone(n));
  }

  function listAll() {
    return read().items.map(n => structuredClone(n));
  }

  function get(id) {
    const hit = read().items.find(n => n.id === id);
    return hit ? structuredClone(hit) : null;
  }

  function markSynced(ids) {
    const state = read();
    for (const n of state.items) if (ids.includes(n.id)) n.synced = true;
    write(state);
  }

  function recordAnswer(id, value, source) {
    const state = read();
    const notice = state.items.find(n => n.id === id);
    if (!notice) throw Object.assign(new Error("That question no longer exists."), { code: "NOTICE_MISSING" });
    notice.answer = { value, source, at: new Date(now()).toISOString() };
    notice.synced = false;
    write(state);
    return structuredClone(notice);
  }

  return { file, raise, listOpen, listAll, get, markSynced, recordAnswer, isExpired };
}

module.exports = { createNoticeBook, digestOf, APPROVAL_LIFETIME_MS };
