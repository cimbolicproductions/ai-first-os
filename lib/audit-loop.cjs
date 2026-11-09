"use strict";

const { labelFor, HARNESSES } = require("./harness-registry.cjs");
const { pickAuditor } = require("./roles.cjs");
const { getSetting } = require("./workspace.cjs");

const MAX_FIX_TASKS_PER_AUDIT = 8;
const AUDIT_CHOICES = Object.freeze([
  { label: "Audit", value: "audit" },
  { label: "Not now", value: "skip" },
]);

/** Is this finished row one the owner should be offered an audit on right now? */
function isAuditable(row, meta, board) {
  if (!row || row.Status !== "Done" || meta?.kind !== "build") return false;
  const audit = meta.audit;
  if (!audit || audit.state === "none") return true;
  if (audit.state !== "fixing") return false;
  return (audit.fixes || []).every(id => board.findTask(id)?.Status === "Done");
}

function auditOffers(board) {
  return board
    .listTasks()
    .filter(row => isAuditable(row, board.getMeta(row.ID), board))
    .map(row => ({ row: row.ID, task: row.Task, action: "Audit" }));
}

/**
 * The one action behind the word "Audit". Sends the finished work to the agent
 * set as auditor. Asks a plain question only when the choice is genuinely open.
 */
function requestAudit({ board, manifest, buildRowId, availability, notices = null }) {
  const row = board.findTask(buildRowId);
  const meta = board.getMeta(buildRowId);
  if (!row) throw Object.assign(new Error(`Task "${buildRowId}" not found`), { code: "TASK_MISSING" });
  if (!isAuditable(row, meta, board)) {
    throw Object.assign(new Error(`${buildRowId} has nothing new to audit.`), { code: "NOT_AUDITABLE" });
  }

  const builder = meta.builder || row.To;
  const standing = getSetting(manifest, "roles.auditor");
  const options = HARNESSES.filter(h => availability[h.id] && h.id !== builder);
  if (!standing && options.length > 1 && notices) {
    const notice = notices.raise({
      row: buildRowId,
      kind: "question",
      text: `${labelFor(builder)} finished ${buildRowId}. Who do you want to check its work?`,
      choices: options.map(h => ({ label: h.label, value: h.id })),
      settingKey: "roles.auditor",
      then: { type: "audit", row: buildRowId },
    });
    return { requested: false, pending: notice };
  }

  const pick = pickAuditor({ builder, manifest, availability });
  if (!pick.agent) {
    const notice = notices?.raise({
      row: buildRowId,
      kind: "blocked",
      text: `No agent is signed in to check ${buildRowId}. Sign one in and tap Audit again.`,
    });
    return { requested: false, blocked: true, notice };
  }

  const round = (meta.audit?.round || 0) + 1;
  const note = pick.sameAsBuilder
    ? `Only ${labelFor(pick.agent)} is available, so it is checking its own work.`
    : `${labelFor(pick.agent)} is checking ${labelFor(builder)}'s work.`;
  const auditRow = board.addTask({
    task: `Audit ${buildRowId}: ${row.Task}`,
    to: pick.agent,
    from: "Audit",
    note,
    meta: { kind: "audit", auditOf: buildRowId, round, builder },
  });
  board.setMeta(buildRowId, { audit: { state: "running", round, row: auditRow.ID } });
  return { requested: true, auditRow, auditor: pick.agent, sameAsBuilder: pick.sameAsBuilder };
}

/**
 * Closes the loop. Findings become fix tasks for the builder automatically, with
 * nobody relaying. An audit that reports neither findings nor a clean result is
 * never treated as clean.
 */
function finishAudit({ board, auditRowId, outcome, notices = null }) {
  const meta = board.getMeta(auditRowId);
  const root = meta.auditOf;
  const rootMeta = board.getMeta(root);
  const findings = (outcome.findings || []).filter(Boolean);

  if (findings.length) {
    const fixes = findings.slice(0, MAX_FIX_TASKS_PER_AUDIT).map(text =>
      board.addTask({
        task: `Fix from audit of ${root}: ${text}`.slice(0, 500),
        to: meta.builder,
        from: "Audit",
        note: `Found by the audit in ${auditRowId}.`,
        meta: { kind: "fix", fixOf: root, auditRow: auditRowId, builder: meta.builder },
      })
    );
    board.setMeta(root, { audit: { ...rootMeta.audit, state: "fixing", fixes: fixes.map(f => f.ID) } });
    const dropped = findings.length - fixes.length;
    notices?.raise({
      row: root,
      kind: "done",
      text: `The audit of ${root} found ${findings.length} thing${findings.length === 1 ? "" : "s"} to fix. ${labelFor(meta.builder)} is on it.${dropped ? ` ${dropped} more are in ${auditRowId}.` : ""}`,
    });
    return { result: "findings", fixes };
  }

  if (outcome.clean) {
    board.setMeta(root, { audit: { ...rootMeta.audit, state: "clean" } });
    notices?.raise({ row: root, kind: "done", text: `The audit of ${root} came back clean.` });
    return { result: "clean", fixes: [] };
  }

  board.setMeta(root, { audit: { ...rootMeta.audit, state: "none" } });
  notices?.raise({
    row: root,
    kind: "blocked",
    text: `The audit of ${root} finished without a clear answer, so nothing was marked clean. You can run it again.`,
    choices: [AUDIT_CHOICES[0]],
    then: { type: "audit", row: root },
  });
  return { result: "unreadable", fixes: [] };
}

/** Called when a fix lands: once every fix is done, suggest the next audit. */
function maybeOfferReaudit({ board, fixRowId, notices = null }) {
  const root = board.getMeta(fixRowId).fixOf;
  if (!root || !isAuditable(board.findTask(root), board.getMeta(root), board)) return null;
  return notices?.raise({
    row: root,
    kind: "done",
    text: `Every fix from the audit of ${root} is done. Audit it again?`,
    choices: AUDIT_CHOICES,
    then: { type: "audit", row: root },
  });
}

module.exports = { AUDIT_CHOICES, isAuditable, auditOffers, requestAudit, finishAudit, maybeOfferReaudit };
