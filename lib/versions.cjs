"use strict";

const { labelFor } = require("./harness-registry.cjs");
const { getSetting } = require("./workspace.cjs");

/**
 * Work moves in versions. Version 1 is shown as soon as it is built. While the
 * outside review runs, the owner can add notes. The review's findings and the
 * owner's notes are combined into one brief, and the same builder makes the
 * next version from it. Nobody merges two lists by hand.
 */
const MAX_NOTE_CHARS = 4000;
const MAX_NOTES = 20;

/** On unless the owner switched it off: build the next version without stopping to ask. */
function keepsGoing(manifest) {
  return getSetting(manifest, "settings.keepGoing") !== false;
}

function rootOf(board, rowId) {
  const meta = board.getMeta(rowId);
  return meta.fixOf || meta.auditOf || rowId;
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function composeBrief({ root, version, findings, notes }) {
  const lines = [`Build version ${version} of ${root}. Change what is listed here and nothing else. Keep everything that already works.`];
  if (findings.length) {
    lines.push("", "From the outside review of the last version:", ...findings.map((item, index) => `${index + 1}. ${item}`));
  }
  if (notes.length) {
    lines.push("", "From the owner, in their words. Where a note and the review disagree, the owner's note wins:", ...notes.map((item, index) => `${index + 1}. ${item}`));
  }
  return lines.join("\n");
}

/** Makes the one task that builds the next version. Returns null when there is nothing to change. */
function startNextVersion({ board, root, findings = [], auditRowId = null }) {
  const row = board.findTask(root);
  const meta = board.getMeta(root);
  const notes = (meta.ownerNotes || []).slice(0, MAX_NOTES);
  const found = findings.filter(Boolean);
  if (!row || (!found.length && !notes.length)) return null;
  const version = (meta.version || 1) + 1;
  const builder = meta.builder || row.To;
  const parts = [found.length ? plural(found.length, "fix from the review", "fixes from the review") : null, notes.length ? plural(notes.length, "note from you", "notes from you") : null].filter(Boolean);
  const task = board.addTask({
    task: `Version ${version} of ${root}: ${parts.join(" and ")}`,
    to: builder,
    from: "Audit",
    note: `Built from ${parts.join(" and ")}.`,
    meta: {
      kind: "fix", fixOf: root, auditRow: auditRowId, builder, version,
      delegatedWork: composeBrief({ root, version, findings: found, notes }),
    },
  });
  board.setMeta(root, {
    version, ownerNotes: [], pendingFindings: null,
    audit: { ...(meta.audit || {}), state: "fixing", fixes: [task.ID] },
  });
  return { task, version, builder, findings: found.length, notes: notes.length };
}

/**
 * A note from the owner for the next version. If a review or a build is in
 * flight the note waits for it. If nothing is running, the note is the request:
 * the next version starts now.
 */
function addVersionNote({ board, rowId, text }) {
  const words = typeof text === "string" ? text.trim() : "";
  if (!words || words.length > MAX_NOTE_CHARS) {
    throw Object.assign(new Error("Enter a note of up to 4,000 characters."), { code: "INVALID_NOTE" });
  }
  const root = rootOf(board, rowId);
  const row = board.findTask(root);
  const meta = board.getMeta(root);
  if (!row || meta.kind !== "build" || row.Status !== "Done") {
    throw Object.assign(new Error("Notes can be added once a first version is built."), { code: "NOT_A_BUILD" });
  }
  const notes = [...(meta.ownerNotes || []), words].slice(-MAX_NOTES);
  board.setMeta(root, { ownerNotes: notes });
  const state = meta.audit?.state || "none";
  const idle = state === "none" || state === "clean";
  const started = idle ? startNextVersion({ board, root }) : null;
  return { root, waiting: !started, started };
}

/** What the owner sees about versions on a task. */
function versionView(board, rowId) {
  const meta = board.getMeta(rowId);
  if (meta.kind !== "build") return null;
  const row = board.findTask(rowId);
  return {
    version: meta.version || 1,
    canNote: row?.Status === "Done",
    notes: (meta.ownerNotes || []).length,
    review: meta.audit?.state || "none",
    builder: meta.builder ? labelFor(meta.builder) : null,
  };
}

module.exports = { keepsGoing, rootOf, startNextVersion, addVersionNote, versionView, composeBrief };
