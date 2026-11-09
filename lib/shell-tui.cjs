"use strict";

const readline = require("node:readline");
const { THEMES, SERVICE_DROPDOWN_CATALOG, connectServiceFromCatalog } = require("./service-catalog.cjs");
const { captureVoiceNative, saveVoiceDumpToInbox, shareToTarget } = require("./voice-and-share.cjs");
const { dispatchBoardTask, answerNotice } = require("./os-runtime.cjs");
const { laneList, labelFor } = require("./harness-registry.cjs");
const { auditOffers, requestAudit } = require("./audit-loop.cjs");
const { availabilityFromDetected } = require("./roles.cjs");
const { cachedDetect } = require("./agent-auth.cjs");
const { buildDailySummary } = require("./daily-summary.cjs");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CLEAR = "\x1b[2J\x1b[H";

function padRight(str, len) {
  const clean = String(str || "");
  if (clean.length >= len) return clean.slice(0, Math.max(0, len - 1)) + "…";
  return clean + " ".repeat(len - clean.length);
}

/**
 * Renders a single frame of the tiling TUI (usable both by the
 * interactive terminal loop and by automated snapshot tests).
 */
function renderTuiFrame({
  manifest,
  tasks = [],
  selectedRowIdx = 0,
  activeLane = "board",
  themeKey = "tokyo-night",
  modal = null,
  statusMessage = "Ready. Press [Space] Command Palette | [c] Connect Dropdown | [s] Share | [v] Voice | [1-6] Lanes",
  cols = 110,
  logs = [],
  notice = null,
  summary = null,
} = {}) {
  const theme = THEMES[themeKey] || THEMES["tokyo-night"];
  const ac = theme.ansiAccent;
  const gr = theme.ansiGreen;
  const yl = theme.ansiYellow;
  const muted = theme.ansiMuted;

  const lanes = laneList().map(l => ({ ...l, label: `${l.key}:${l.label}` }));

  // Top status bar
  const lanePills = lanes
    .map(l => (l.id === activeLane ? `${ac}${BOLD}[■ ${l.label}]${RESET}` : `${muted}[  ${l.label}]${RESET}`))
    .join(" ");
  const connectedCount = Object.keys(manifest.connections || {}).length;
  const routerName = manifest.ideology?.routerFunnel || "Router";
  const topBar = `${ac}${BOLD} AI-first OS ${RESET} ${lanePills}  ${gr}● Router:${routerName}${RESET}  ${yl}⚡ Services:${connectedCount}${RESET}  ${muted}Theme:${theme.name}${RESET}`;

  const divider = `${muted}${"─".repeat(Math.min(cols, 110))}${RESET}`;
  const leftWidth = 56;
  const rightWidth = Math.max(40, Math.min(cols, 110) - leftWidth - 3);

  const leftLines = [
    `${ac}${BOLD}TASK BOARD (${manifest.board?.mode || "local"})${RESET}`,
    `${muted}${padRight("ID", 5)} ${padRight("TO", 9)} ${padRight("STATUS", 15)} ${padRight("TASK", 24)}${RESET}`,
  ];

  if (!tasks.length) {
    leftLines.push(`${muted}  (No tasks on board - press [n] to add)${RESET}`);
  } else {
    tasks.slice(0, 12).forEach((r, idx) => {
      const pointer = idx === selectedRowIdx ? `${ac}${BOLD}>${RESET}` : " ";
      const statusColor = r.Status === "Done" ? gr : r.Status === "In progress" ? yl : RESET;
      const line = `${pointer}${padRight(r.ID, 4)} ${padRight(r.To, 9)} ${statusColor}${padRight(r.Status, 15)}${RESET} ${padRight(r.Task, 24)}`;
      leftLines.push(line);
    });
  }

  const selectedTask = tasks[selectedRowIdx] || null;
  const rightLines = [
    `${ac}${BOLD}ACTIVE WORKSPACE: ${activeLane.toUpperCase()}${RESET}`,
  ];

  if (notice) {
    rightLines.push(`${yl}${BOLD}┌─ WAITING ON YOU ───────────────────────┐${RESET}`);
    rightLines.push(`  ${padRight(notice.text, rightWidth - 2)}`);
    notice.choices.forEach((c, i) => rightLines.push(`  [${i + 1}] ${c.label}`));
    rightLines.push(`${yl}${BOLD}└────────────────────────────────────────┘${RESET}`);
  } else if (summary) {
    rightLines.push(`${gr}${BOLD}TODAY${RESET}`);
    rightLines.push(`  ${padRight(summary.headline, rightWidth - 2)}`);
    for (const f of summary.finished.slice(0, 6)) rightLines.push(`  ${padRight(`${f.by}: ${f.task}`, rightWidth - 2)}`);
    for (const w of summary.waiting.slice(0, 4)) rightLines.push(`  ${padRight(`Waiting: ${w.text}`, rightWidth - 2)}`);
  } else if (modal === "palette") {
    rightLines.push(`${yl}${BOLD}┌─ COMMAND PALETTE [Space] ──────────────┐${RESET}`);
    rightLines.push(`  [r] Run / Dispatch selected board row`);
    rightLines.push(`  [n] New Task on Shared Board`);
    rightLines.push(`  [s] Share to Antigravity / Claude / Codex / Gemini`);
    rightLines.push(`  [c] Connect Service Dropdown (MCP / REST / Board)`);
    rightLines.push(`  [v] Native Voice-to-Text Capture`);
    rightLines.push(`  [t] Cycle Theme (${theme.name})`);
    rightLines.push(`  [q] Quit Shell`);
    rightLines.push(`${yl}${BOLD}└────────────────────────────────────────┘${RESET}`);
  } else if (modal === "connect") {
    rightLines.push(`${gr}${BOLD}┌─ CONNECT SERVICE DROPDOWN [c] ─────────┐${RESET}`);
    SERVICE_DROPDOWN_CATALOG.slice(0, 8).forEach((svc, i) => {
      const isConn = Boolean(manifest.connections?.[svc.id] || manifest.agents?.[svc.id]);
      rightLines.push(`  [${i + 1}] ${isConn ? "●" : "○"} ${padRight(svc.label, rightWidth - 10)}`);
    });
    rightLines.push(`${gr}${BOLD}└────────────────────────────────────────┘${RESET}`);
  } else if (modal === "share") {
    rightLines.push(`${ac}${BOLD}┌─ EASY SHARE TO AGENT [s] ──────────────┐${RESET}`);
    rightLines.push(`  [a] Share -> Antigravity (agy)`);
    rightLines.push(`  [u] Share -> Cursor`);
    rightLines.push(`  [l] Share -> Claude Code (claude)`);
    rightLines.push(`  [x] Share -> Codex (codex)`);
    rightLines.push(`  [g] Share -> Gemini Research (gemini)`);
    rightLines.push(`  [b] Share -> Router Task Board`);
    rightLines.push(`${ac}${BOLD}└────────────────────────────────────────┘${RESET}`);
  } else if (selectedTask) {
    rightLines.push(`${BOLD}Row:${RESET} ${selectedTask.ID} -> ${selectedTask.To} [${selectedTask.Status}]`);
    rightLines.push(`${BOLD}Task:${RESET} ${padRight(selectedTask.Task, rightWidth - 6)}`);
    rightLines.push(`${BOLD}Spec:${RESET} ${padRight(selectedTask["Spec file"] || "none", rightWidth - 6)}`);
    rightLines.push(`${muted}── Latest Note ──────────────────────────${RESET}`);
    const noteLines = String(selectedTask["Latest note"] || "").split(/\r?\n/).slice(-4);
    for (const nl of noteLines) {
      rightLines.push(`  ${padRight(nl, rightWidth - 2)}`);
    }
    if (logs.length) {
      rightLines.push(`${muted}── Live Agent Stream ────────────────────${RESET}`);
      for (const lg of logs.slice(-3)) {
        rightLines.push(`  ${padRight(lg, rightWidth - 2)}`);
      }
    }
  }

  const maxRows = Math.max(leftLines.length, rightLines.length, 14);
  const bodyLines = [];
  for (let i = 0; i < maxRows; i++) {
    const l = leftLines[i] || "";
    const r = rightLines[i] || "";
    // Strip ANSI to compute visible padding for left column
    const visibleLeft = l.replace(/\x1b\[[0-9;]*m/g, "");
    const padCount = Math.max(1, leftWidth - visibleLeft.length);
    bodyLines.push(`${l}${" ".repeat(padCount)}${muted}│${RESET} ${r}`);
  }

  const footer = [
    divider,
    `${ac}${BOLD}KEYS:${RESET} [Space] Palette  [1-6] Toggle Agent  [j/k] Row  [r] Run Row  [a] Audit  [d] Today  [s] Share  [v] Voice  [c] Connect  [t] Theme  [q] Quit`,
    `${yl}STATUS:${RESET} ${statusMessage}`,
  ].join("\n");

  return [topBar, divider, ...bodyLines, footer].join("\n");
}

function startTui({
  workspaceRoot = process.cwd(),
  manifest,
  board,
  notices = null,
  onSaveManifest,
} = {}) {
  const themeKeys = Object.keys(THEMES);
  let themeIdx = 0;
  let selectedRowIdx = 0;
  let activeLane = "board";
  let modal = null;
  let statusMessage = "AI-first OS active. Zero mouse needed.";
  const logs = [];
  let showToday = false;
  const openNotice = () => (notices ? notices.listOpen().find(n => n.choices.length) || null : null);

  function draw() {
    const tasks = board.listTasks();
    if (selectedRowIdx >= tasks.length) selectedRowIdx = Math.max(0, tasks.length - 1);
    const frame = renderTuiFrame({
      manifest,
      tasks,
      selectedRowIdx,
      activeLane,
      themeKey: themeKeys[themeIdx],
      modal,
      statusMessage,
      cols: process.stdout.columns || 110,
      logs,
      notice: openNotice(),
      summary: showToday ? buildDailySummary({ board, notices }) : null,
    });
    process.stdout.write(CLEAR + frame + "\n");
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  draw();

  process.stdin.on("keypress", async (str, key) => {
    if (!key) return;
    if (key.ctrl && key.name === "c") {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write("\n");
      process.exit(0);
    }

    const tasks = board.listTasks();
    const currentTask = tasks[selectedRowIdx] || null;

    const pending = openNotice();
    if (pending && /^[1-9]$/.test(str || "") && pending.choices[Number(str) - 1]) {
      try {
        answerNotice({
          noticeId: pending.id,
          value: pending.choices[Number(str) - 1].value,
          digest: pending.digest,
          source: "computer",
          notices,
          board,
          manifest,
          saveManifest: next => onSaveManifest?.(next),
          availability: availabilityFromDetected(cachedDetect()),
        });
        statusMessage = "Got it.";
      } catch (err) {
        statusMessage = err.message;
      }
      draw();
      return;
    }

    if (modal === "share") {
      const targetMap = { a: "agy", u: "cursor", l: "claude", x: "codex", g: "gemini", b: "board" };
      if (targetMap[str]) {
        const payload = currentTask ? `${currentTask.ID}: ${currentTask.Task}` : "Shared from AI-first OS";
        const res = shareToTarget({
          target: targetMap[str],
          content: payload,
          workspaceRoot,
          vaultPath: manifest.vaultPath,
          board,
          routerName: manifest.ideology?.routerFunnel || "Router",
        });
        statusMessage = `Shared to ${res.target.toUpperCase()} (${res.boardRow ? res.boardRow.ID : "handoff saved"})`;
        modal = null;
        draw();
        return;
      }
      modal = null;
      draw();
      return;
    }

    if (modal === "connect") {
      const idx = Number(str) - 1;
      if (idx >= 0 && idx < 8) {
        const svc = SERVICE_DROPDOWN_CATALOG[idx];
        const updated = connectServiceFromCatalog(manifest, svc.id);
        Object.assign(manifest, updated.manifest);
        if (typeof onSaveManifest === "function") onSaveManifest(manifest);
        statusMessage = `Connected ${svc.label} into aios.yaml`;
      }
      modal = null;
      draw();
      return;
    }

    if (key.name === "q" && !modal) {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write("\n");
      process.exit(0);
    }
    if (key.name === "escape") {
      modal = null;
      draw();
      return;
    }
    if (key.name === "space" || str === "/") {
      modal = modal === "palette" ? null : "palette";
      draw();
      return;
    }
    const lane = laneList().find(l => l.key === str);
    if (lane) {
      activeLane = lane.id;
      modal = null;
      showToday = false;
      draw();
      return;
    }
    if (str === "d") {
      showToday = !showToday;
      draw();
      return;
    }
    if (str === "a") {
      if (!currentTask || !auditOffers(board).some(o => o.row === currentTask.ID)) {
        statusMessage = "Nothing new to audit on this row.";
      } else {
        try {
          const res = requestAudit({ board, manifest, buildRowId: currentTask.ID, availability: availabilityFromDetected(cachedDetect()), notices });
          statusMessage = res.requested ? `${labelFor(res.auditor)} is checking ${currentTask.ID}.` : "One question first.";
        } catch (err) {
          statusMessage = err.message;
        }
      }
      draw();
      return;
    }

    if (str === "j" || key.name === "down") {
      selectedRowIdx = Math.min(tasks.length - 1, selectedRowIdx + 1);
      draw();
      return;
    }
    if (str === "k" || key.name === "up") {
      selectedRowIdx = Math.max(0, selectedRowIdx - 1);
      draw();
      return;
    }
    if (str === "t") {
      themeIdx = (themeIdx + 1) % themeKeys.length;
      statusMessage = `Switched theme to ${THEMES[themeKeys[themeIdx]].name}`;
      draw();
      return;
    }
    if (str === "c") {
      modal = modal === "connect" ? null : "connect";
      draw();
      return;
    }
    if (str === "s") {
      modal = modal === "share" ? null : "share";
      draw();
      return;
    }
    if (str === "v") {
      statusMessage = "Listening via native OS Voice-to-Text (speak now)...";
      draw();
      const cap = captureVoiceNative({ timeoutSeconds: 6 });
      if (cap.ok && cap.transcript) {
        const saved = saveVoiceDumpToInbox({
          vaultPath: manifest.vaultPath,
          transcript: cap.transcript,
          routerName: manifest.ideology?.routerFunnel || "Router",
          board,
          autoQueueTo: activeLane === "board" ? manifest.roles?.builder || "claude" : activeLane,
        });
        statusMessage = `Voice captured -> ${saved.boardRow ? saved.boardRow.ID : "00_Inbox"}: "${cap.transcript}"`;
      } else {
        statusMessage = cap.error || "No speech detected.";
      }
      draw();
      return;
    }
    if (str === "r" && currentTask) {
      statusMessage = `Dispatching ${currentTask.ID} to ${currentTask.To}...`;
      draw();
      const res = await dispatchBoardTask({
        workspaceRoot,
        manifest,
        board,
        notices,
        taskId: currentTask.ID,
      });
      logs.push(`${currentTask.ID} -> ${res.status} (${res.agent})`);
      statusMessage = auditOffers(board).some(o => o.row === currentTask.ID)
        ? `${currentTask.ID} landed. Press [a] to audit it.`
        : `${currentTask.ID}: ${res.status}`;
      modal = null;
      draw();
    }
  });
}

module.exports = {
  renderTuiFrame,
  startTui,
};
