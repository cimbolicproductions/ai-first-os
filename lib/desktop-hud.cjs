"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { THEMES, SERVICE_DROPDOWN_CATALOG, connectServiceFromCatalog } = require("./service-catalog.cjs");
const { saveVoiceDumpToInbox, shareToTarget } = require("./voice-and-share.cjs");
const { dispatchBoardTask, answerNotice, queueOrganizerRequest, replyToOrganizer, agentCoolingDown } = require("./os-runtime.cjs");
const { detectInstalledAgents, openSignInWindow } = require("./agent-auth.cjs");
const { HARNESSES, PERSONAL_AGENTS, labelFor, laneList } = require("./harness-registry.cjs");
const { availabilityFromDetected } = require("./roles.cjs");
const { createNoticeBook } = require("./notices.cjs");
const { auditOffers, requestAudit } = require("./audit-loop.cjs");
const { buildDailySummary, applyUndo } = require("./daily-summary.cjs");
const { buildIntroModel } = require("./first-run.cjs");
const { buildIntroHtml } = require("./first-run-page.cjs");
const { createSheetTasks } = require("./sheet-tasks.cjs");
const { mirrorTarget } = require("./sheet-board.cjs");

const SHEET_TASK_STATUSES = ["Open", "In progress", "Waiting on Dom", "Done"];

const BRAND_DIR = path.join(__dirname, "..", "phone");
const BRAND_FILES = Object.freeze({
  "/brand/loading.gif": ["loading.gif", "image/gif"],
  "/brand/logo.png": ["logo.png", "image/png"],
});

function buildDesktopHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI-first OS</title>
<link rel="icon" href="/brand/logo.png" />
<style>
  :root {
    --bg: #1a1b26; --panel: #24283b; --border: #414868;
    --text: #c0caf5; --muted: #8089b3; --accent: #7aa2f7;
    --green: #9ece6a; --yellow: #e0af68; --red: #f7768e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  [hidden] { display: none !important; }
  #boot { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; z-index: 60; }
  #boot img { width: 112px; height: 112px; border-radius: 26px; }
  .brand-row { display: flex; align-items: center; gap: 10px; }
  #brandMark { width: 22px; height: 22px; border-radius: 5px; display: block; flex: none; }
  #phoneSpin { width: 72px; height: 72px; border-radius: 17px; display: block; margin: 4px auto; }
  body {
    background: var(--bg); color: var(--text);
    font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }
  header {
    min-height: 36px; background: var(--panel); border-bottom: 2px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; padding: 0 12px;
    font-size: 12px; gap: 12px;
  }
  .workspaces { display: flex; gap: 6px; flex-wrap: wrap; }
  .ws-pill {
    padding: 3px 9px; border: 1px solid var(--border); cursor: pointer; border-radius: 3px;
    color: var(--muted); user-select: none; background: none; font: inherit;
  }
  .ws-pill.active { border-color: var(--accent); color: var(--bg); background: var(--accent); font-weight: 700; }
  .status-cluster { display: flex; gap: 12px; align-items: center; white-space: nowrap; }
  .badge-green { color: var(--green); }
  .badge-yellow { color: var(--yellow); cursor: pointer; background: none; border: 0; font: inherit; }
  #askBar {
    background: var(--accent); color: var(--bg); padding: 10px 14px; display: flex;
    align-items: center; justify-content: space-between; gap: 14px; font-size: 13px; font-weight: 700;
  }
  #askChoices { display: flex; gap: 6px; flex: none; }
  #askChoices button { background: var(--bg); color: var(--text); }
  main {
    flex: 1; display: grid; grid-template-columns: 1.25fr 1fr; gap: 8px; padding: 8px; overflow: hidden;
  }
  .tile {
    background: var(--panel); border: 2px solid var(--border); border-radius: 4px;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .tile.focused { border-color: var(--accent); }
  .tile-header {
    padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px;
    font-weight: 700; color: var(--accent); display: flex; justify-content: space-between;
  }
  .tile-body { flex: 1; overflow-y: auto; padding: 10px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 7px 6px; border-bottom: 1px solid var(--border); }
  tr.selected { background: rgba(122, 162, 247, 0.18); outline: 1px solid var(--accent); }
  tbody tr:hover { background: rgba(255,255,255,0.04); cursor: pointer; }
  .sub { color: var(--yellow); }
  .lane-box { display: flex; flex-direction: column; gap: 10px; height: 100%; }
  .btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .btn-row select { flex: 1; min-width: 0; width: 100%; }
  #firstTask { padding: 36px 8px; text-align: center; color: var(--muted); font-size: 14px; line-height: 1.7; }
  pre {
    background: var(--bg); border: 1px solid var(--border); padding: 10px; border-radius: 4px;
    white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; flex: 1; overflow-y: auto;
  }
  footer {
    min-height: 30px; background: var(--panel); border-top: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; padding: 0 12px; font-size: 11px; color: var(--muted); gap: 12px;
  }
  kbd {
    background: var(--bg); color: var(--accent); border: 1px solid var(--border);
    padding: 1px 5px; border-radius: 3px; font-size: 11px;
  }
  dialog::backdrop { background: rgba(0,0,0,0.68); }
  dialog { margin: auto; padding: 0; color: var(--text); background: var(--panel); border: 0; }
  .modal {
    width: 620px; max-width: 92vw; max-height: 86vh; overflow-y: auto; background: var(--panel); border: 2px solid var(--accent);
    border-radius: 6px; padding: 14px; display: flex; flex-direction: column; gap: 10px; font-size: 13px;
  }
  .modal h3 { color: var(--accent); font-size: 13px; }
  input, select, button {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    padding: 8px 10px; font-family: inherit; font-size: 13px; border-radius: 4px;
  }
  button { background: var(--accent); color: var(--bg); font-weight: 700; cursor: pointer; border: none; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; }
  .line { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--border); }
  .line label { flex: 1; }
  body[data-mode="easy"] .advanced-only { display: none !important; }
  body[data-mode="easy"] { font-family: system-ui, sans-serif; }
  body[data-mode="easy"] main { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
  .board-list { list-style: none; display: grid; gap: 6px; }
  .task-choice { background: transparent; color: var(--text); text-align: left; font-weight: 400; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; width: 100%; border: 1px solid var(--border); padding: 10px 12px; }
  .task-choice[aria-current="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, var(--panel)); }
  .task-title { flex-basis: 100%; font-weight: 650; overflow-wrap: anywhere; }
  .task-label, .task-update { color: var(--muted); font-size: 12px; }
  .task-update { flex-basis: 100%; }
  [data-status="Working"] { color: var(--accent); }
  [data-status="Needs you"] { color: var(--yellow); }
  [data-status="Failed"] { color: var(--red); }
  .text-button { background: none; color: var(--accent); }
  .board-tools { margin-top: 6px; }
  #requestDetail, #taskReply, #taskActivity, #taskChildren { display: grid; gap: 8px; }
  #conversation, #replyForm { display: grid; gap: 8px; }
  #conversation { list-style: none; }
  #conversation li { padding: 8px 10px; border-inline-start: 2px solid var(--accent); background: var(--bg); }
  #conversation li[data-speaker="user"] { border-color: var(--border); }
  #conversation p { margin-top: 4px; overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.6; }
  #replyForm button, #replyJump { justify-self: start; }
  #replyInput { width: 100%; }
  #replyStatus, #agentsStatus { line-height: 1.5; }
  #agentList { display: grid; gap: 4px; }
  #agentList .line { flex-wrap: wrap; }
  #taskQuestion, #taskAnswer { overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.6; }
  #taskChildren { list-style: none; }
  #activityList { list-style: none; display: grid; gap: 6px; }
  #activityList time { font-size: 11px; color: var(--muted); padding-left: 8px; }
  #technicalDetails summary { cursor: pointer; margin-bottom: 6px; }
  #workCaption { color: var(--muted); }
  header { flex-wrap: wrap; padding: 12px 16px; }
  .status-cluster { flex-wrap: wrap; }
  .composer { padding: 20px 24px; display: grid; gap: 10px; border-bottom: 1px solid var(--border); }
  .composer h1 { font-size: 24px; }
  .composer p, #boardSummary, .help { color: var(--text); font-size: 13px; line-height: 1.6; }
  .composer form { display: flex; gap: 10px; }
  textarea { resize: vertical; min-height: 74px; max-height: 180px; flex: 1; min-width: 0; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 12px; font: inherit; }
  textarea:focus-visible { outline: 2px solid var(--accent); }
  button:disabled { opacity: .55; cursor: default; }
  .tile { min-width: 0; }
  td { overflow-wrap: anywhere; }
  #inspectorPre { font: inherit; line-height: 1.6; }
  #requestInput { font-size: 16px; }
  #requestInput::placeholder { color: var(--muted); }
  #requestForm { align-items: stretch; }
  .capture-actions button { min-height: 36px; }
  #crewRow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 10px; font-size: 13px; color: var(--muted); }
  #crewRow label { display: inline-flex; align-items: center; gap: 6px; }
  #crewRow select { font: inherit; color: var(--text); background: transparent; border: 1px solid var(--border); border-radius: 8px; padding: 4px 8px; max-width: 150px; }
  #crewRow input { accent-color: var(--accent); }
  .crew-pair { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  #captureStatus { color: var(--accent); }
  #sheetTasksForm { display: grid; gap: 9px; }
  #sheetTasksForm .sheet-field { display: grid; gap: 5px; }
  #sheetTasksForm select, #sheetTasksForm textarea { width: 100%; }
  #sheetTasksForm button { justify-self: start; }
  #askBar { flex-wrap: wrap; overflow-wrap: anywhere; }
  #askChoices { flex-wrap: wrap; max-width: 100%; }
  @media (prefers-reduced-motion: reduce) {
    #workCaption { display: none; }
  }
  .tile-header { flex-wrap: wrap; gap: 8px; }
  .modal-close { align-self: flex-end; }
  .agent-tools button { background: transparent; color: var(--accent); padding: 3px 6px; }
  @media (max-width: 720px), (max-height: 540px) {
    body { height: auto; min-height: 100vh; overflow: auto; }
    main, body[data-mode="easy"] main { grid-template-columns: minmax(0, 1fr); overflow: visible; }
    .tile-body { max-height: 380px; }
    .composer { padding: 16px; }
    .composer form { flex-direction: column; }
    footer { flex-wrap: wrap; padding: 12px; }
  }
</style>
</head>
<body data-mode="easy">
<div id="boot" role="status" aria-label="Loading"><img id="bootMark" src="/brand/logo.png" alt="" /></div>
<header>
  <div class="brand-row">
    <img id="brandMark" src="/brand/logo.png" alt="" />
    <strong>AI-first OS</strong><div class="workspaces advanced-only" id="wsBar"></div>
  </div>
  <div class="status-cluster">
    <span class="badge-green" id="routerBadge"></span>
    <button class="badge-yellow" id="agentsBtn">AI services</button>
    <button class="badge-yellow" id="phoneBtn">Use your phone</button>
    <button id="modeBtn" aria-pressed="false">Advanced mode</button>
    <button class="badge-yellow advanced-only" id="voiceBtn">[V] Voice</button>
    <button class="badge-yellow advanced-only" id="themeBtn">[T] Theme</button>
  </div>
</header>

<div id="askBar" hidden role="alert"><span id="askText"></span><div id="askChoices"></div></div>

<section class="composer" aria-labelledby="promptTitle">
  <h1 id="promptTitle">What would you like to get done?</h1>
  <p id="organizerHint">Say it or type it. Your organizer takes it from there.</p>
  <form id="requestForm">
    <textarea id="requestInput" aria-label="Message your organizer" aria-describedby="requestHelp" placeholder="Try asking: What tasks are open?" maxlength="16000" required></textarea>
    <button id="sendBtn" type="submit">Send request</button>
  </form>
  <div class="btn-row capture-actions">
    <button type="button" class="text-button" id="voiceDumpBtn">Voice dump</button>
    <button type="button" class="text-button" id="addSheetTasksBtn" hidden>Add tasks</button>
    <button type="button" class="text-button" id="sheetTasksBtn" hidden>Sheet tasks</button>
  </div>
  <div id="crewRow" aria-label="Who does what"></div>
  <p class="help" id="requestHelp"><kbd>Enter</kbd> sends · <kbd>Shift</kbd> + <kbd>Enter</kbd> adds a line</p>
  <p id="captureStatus" role="status" hidden></p>
  <button id="replyJump" type="button" hidden>Answer your organizer</button>
</section>
<main>
  <section class="tile focused">
    <div class="tile-header">
      <span>Your board</span><span id="boardSummary"></span>
      <span class="advanced-only"><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>n</kbd> new · <kbd>r</kbd> run</span>
    </div>
    <div class="tile-body">
      <div id="firstTask" hidden>Your first request will appear here.<br>Type above or press <kbd>Space</kbd> to get started.</div>
      <ul class="board-list" id="easyBoard" aria-label="Requests"></ul>
      <div class="board-tools"><button class="text-button" id="completedToggle" aria-pressed="false" hidden>Show completed</button></div>
      <table id="boardTable" class="advanced-only">
        <thead><tr><th>ID</th><th>To</th><th>Status</th><th>Task</th></tr></thead>
        <tbody id="boardBody"></tbody>
      </table>
    </div>
  </section>

  <section class="tile">
    <div class="tile-header">
      <span id="laneTitle"></span>
      <div class="btn-row advanced-only agent-tools">
        <button id="todayBtn"><kbd>D</kbd> Today</button>
        <button id="rolesBtn"><kbd>O</kbd> Roles</button>
        <button id="moreBtn"><kbd>S</kbd> Share and connect</button>
      </div>
    </div>
    <div class="tile-body lane-box">
      <div class="btn-row"><button id="runBtn" hidden>Run selected task</button></div>
      <div class="btn-row advanced-only" id="auditRow" hidden><button id="auditBtn">Audit</button></div>
      <p id="detailEmpty">Select a request to see its progress and reply.</p>
      <article id="requestDetail" hidden>
        <button class="text-button" id="parentTask" hidden></button>
        <h3 id="taskQuestion"></h3>
        <p id="taskOwner" class="task-label"></p>
        <ol id="conversation" aria-label="Conversation" hidden></ol>
        <form id="replyForm" hidden>
          <label id="replyLabel" for="replyInput">Your reply</label>
          <textarea id="replyInput" aria-describedby="replyStatus" placeholder="Type your answer…" maxlength="4000" required></textarea>
          <button id="replyBtn" type="submit">Send reply</button>
          <p id="replyStatus" role="status"></p>
        </form>
        <div id="taskReply" hidden>
          <h4>Reply</h4>
          <p id="taskAnswer"></p>
        </div>
        <section id="taskActivity" aria-label="Progress" hidden>
          <h4>Progress</h4>
          <ol id="activityList"></ol>
        </section>
        <p id="workCaption" aria-hidden="true" hidden></p>
        <section id="relatedWork" hidden>
          <h4>Related work</h4>
          <ul id="taskChildren"></ul>
        </section>
        <details id="technicalDetails">
          <summary>Technical details</summary>
          <pre id="inspectorPre"></pre>
        </details>
      </article>
    </div>
  </section>
</main>

<footer>
  <div><kbd>Space</kbd> Start typing · Select a queued task and press <kbd>R</kbd> to run now<span class="advanced-only"> · <kbd>1-6</kbd> Switch agent · <kbd>A</kbd> Audit · <kbd>D</kbd> Today · <kbd>V</kbd> Voice</span></div>
  <div id="statusBar" role="status">Ready</div>
</footer>

<dialog id="paletteModal">
  <div class="modal">
    <h3>NEW TASK</h3>
    <input id="quickTaskInput" aria-label="New task" placeholder="Say what you need and press Enter" />
  </div>
</dialog>

<dialog id="phoneModal">
  <div class="modal">
    <h3>USE YOUR PHONE</h3>
    <img id="phoneSpin" src="/brand/logo.png" alt="" hidden />
    <p id="phoneText" role="status"></p>
    <input id="phoneLink" aria-label="Your phone link" readonly hidden />
    <div class="btn-row">
      <button id="phoneGo" hidden></button>
      <button id="phoneCopy" hidden>Copy link</button>
    </div>
  </div>
</dialog>

<dialog id="sheetTasksModal">
  <div class="modal">
    <h3>Sheet tasks</h3>
    <p id="sheetTasksStatus" role="status"></p>
    <form id="sheetTasksForm" hidden>
      <div class="sheet-field">
        <label for="sheetTaskId">Task</label>
        <select id="sheetTaskId"></select>
      </div>
      <div class="sheet-field">
        <label for="sheetTaskDescription">Task description</label>
        <textarea id="sheetTaskDescription" maxlength="2000" required></textarea>
      </div>
      <div class="sheet-field">
        <label for="sheetTaskStatus">Status</label>
        <select id="sheetTaskStatus">${SHEET_TASK_STATUSES.map(status => `<option>${status}</option>`).join("")}</select>
      </div>
      <button type="submit" id="updateSheetTaskBtn">Save changes</button>
    </form>
    <div class="btn-row">
      <button type="button" id="sheetTasksRefresh">Refresh</button>
      <button type="button" id="sheetTasksAdd">Add tasks</button>
    </div>
  </div>
</dialog>

<dialog id="agentsModal">
  <div class="modal">
    <h3>AI services</h3>
    <p id="agentsStatus" role="status"></p>
    <div id="agentList"></div>
    <div class="btn-row"><button id="checkAgentsBtn" type="button">Check again</button></div>
  </div>
</dialog>

<dialog id="moreModal">
  <div class="modal">
    <h3>SHARE THIS ROW</h3>
    <div class="btn-row" id="shareRow"></div>
    <h3>CONNECT A SERVICE</h3>
    <div class="btn-row">
      <select id="serviceSelect" aria-label="Service"></select>
      <button id="connectBtn">Connect</button>
    </div>
  </div>
</dialog>

<dialog id="todayModal">
  <div class="modal"><h3 id="todayHead"></h3><div id="todayBody"></div></div>
</dialog>

<dialog id="rolesModal">
  <div class="modal"><h3>WHO DOES WHAT</h3><div id="rolesBody"></div></div>
</dialog>

<script>
const state = {
  advanced: false, busy: false, sending: false, offline: false, showCompleted: false, selectedId: null,
  tasks: [], taskMeta: {}, activeLane: "board", themes: {}, catalog: [], themeKeys: [], themeIdx: 0,
  lanes: [], notices: [], offers: [], roles: {}, roleChoices: {}, substitutions: {}, organizer: "Organizer",
};
const replyDrafts = new Map();
let replyingTo = null;
let captureMode = false;
let recognition = null;
let captureAttempt = null;
let capturePending = false;
let sheetTasks = [];
let sheetUpdateAttempt = null;
let sheetLoading = false;
let sheetUpdating = false;
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
const captions = ["Teaching a penguin keyboard shortcuts…", "Solving world issues, one tab at a time…", "Understanding evolution…"];
const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(r => r.json());
const setStatus = msg => { $("statusBar").textContent = msg; };
const anyModalOpen = () => document.querySelector("dialog[open]");
function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

let refreshVersion = 0;
let previousView;

async function fetchState() {
  const version = ++refreshVersion;
  const view = await fetch("/api/state").then(r => r.text());
  if (version !== refreshVersion) return;
  if (view === previousView) return;
  const data = JSON.parse(view);
  if (!data.ok) throw new Error(data.error || "Could not load the board.");
  previousView = view;
  Object.assign(state, {
    tasks: data.tasks || [], taskMeta: data.taskMeta || {}, themes: data.themes || {}, catalog: data.catalog || [], themeKeys: Object.keys(data.themes || {}),
    lanes: data.lanes || [], notices: data.notices || [], offers: data.offers || [], roles: data.roles || {}, roleChoices: data.roleChoices || {}, substitutions: data.substitutions || {},
  });
  state.organizer = data.organizer || "Organizer";
  state.sheetConnected = data.sheetConnected === true;
  state.crew = data.crew || null;
  render();
}

function applyTheme(key) {
  const t = state.themes[key];
  if (!t) return;
  const r = document.documentElement.style;
  ["bg","panel","border","text","muted","accent","green","yellow","red"].forEach(k => r.setProperty("--" + k, t[k]));
  setStatus("Theme: " + t.name);
}

function switchLane(id) { state.activeLane = id; render(); }

function renderLanes() {
  const bar = $("wsBar");
  bar.replaceChildren(...state.lanes.map(l => {
    const b = document.createElement("button");
    b.className = "ws-pill" + (l.id === state.activeLane ? " active" : "");
    b.textContent = "[" + l.key + "] " + l.label;
    b.setAttribute("aria-pressed", String(l.id === state.activeLane));
    b.onclick = () => switchLane(l.id);
    return b;
  }));
  const lane = state.lanes.find(l => l.id === state.activeLane);
  $("laneTitle").textContent = state.advanced ? "WORKSPACE: " + (lane ? lane.label.toUpperCase() : "") : "Progress and replies";
  const share = state.lanes.filter(l => l.id !== "board").map(l => {
    const b = document.createElement("button");
    b.textContent = "Share to " + l.label;
    b.onclick = () => shareCurrent(l.id);
    return b;
  });
  $("shareRow").replaceChildren(...share);
}

function renderAsk() {
  const n = state.notices.find(x => x.choices?.length &&
    (state.advanced || (x.row === state.selectedId && x.kind !== "done")));
  $("askBar").hidden = !n;
  if (!n) return;
  if ($("askBar").dataset.noticeId === n.id && $("askChoices").childElementCount) return;
  $("askBar").dataset.noticeId = n.id;
  $("askText").textContent = n.text;
  $("askChoices").replaceChildren(...n.choices.map(c => {
    const b = document.createElement("button");
    b.textContent = c.label;
    b.onclick = async () => {
      const res = await post("/api/answer", { noticeId: n.id, digest: n.digest, value: c.value });
      setStatus(res.ok ? "Got it." : res.error);
      await fetchState();
    };
    return b;
  }));
}

function agentLabel(id) {
  return [...state.lanes, ...(state.roleChoices.orchestrator || [])].find(item => item.id === id)?.label || id;
}

function describeTask(row) {
  const meta = state.taskMeta[row.ID] || {};
  const latest = meta.progress?.at(-1);
  const labels = { Open: "Queued", "In progress": "Working", "Waiting on User": "Needs you", "Waiting on Dom": "Needs you", Done: "Done" };
  const status = latest?.stage === "failed" && row.Status !== "Open" && row.Status !== "In progress" ? "Failed" : labels[row.Status] || row.Status;
  const executor = Object.hasOwn(meta, "executor") ? meta.executor : (row.Status === "In progress" ? row.To : null);
  return { status, executor, latest, meta };
}

function progressLabel(event) {
  const agent = event.agent && agentLabel(event.agent);
  switch (event.stage) {
    case "queued": return "Request queued";
    case "planning": return state.organizer + " is reviewing your request" + (agent ? " with " + agent : "");
    case "delegated": return agent ? "Sent to " + agent : "Work delegated";
    case "running": return agent ? "Sent to " + agent : "Work started";
    case "fallback": return agent ? "Switched to " + agent : "Switching agents";
    case "unavailable": return agent ? agent + " was unavailable" : "Service unavailable";
    case "retrying": return "Trying again shortly";
    case "verifying": return agent ? agent + " is verifying the work" : "Verifying the work";
    case "waiting": return "Waiting for your answer";
    case "completed": return agent ? agent + " finished" : "Request complete";
    case "failed": return agent ? agent + " could not finish" : "Work could not finish";
    default: return "";
  }
}

const selectedTask = () => state.tasks.find(row => row.ID === state.selectedId);
function selectTask(id) {
  if (state.selectedId !== id) $("technicalDetails").open = false;
  state.selectedId = id;
  render();
}

function taskChoice(row, display = describeTask(row)) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.className = "task-choice";
  button.dataset.taskId = row.ID;
  button.setAttribute("aria-current", String(row.ID === state.selectedId));
  const title = document.createElement("span");
  title.className = "task-title";
  const headline = row.Task.trim().replace(/\\s+/g, " ");
  title.textContent = headline.length > 105 ? headline.slice(0, 102) + "…" : headline;
  const badge = document.createElement("span");
  badge.className = "task-label";
  badge.dataset.status = display.status;
  badge.textContent = display.status;
  button.append(title, badge);
  const { executor, latest } = display;
  if (executor) {
    const worker = document.createElement("span");
    worker.className = "task-label";
    worker.textContent = agentLabel(executor);
    button.append(worker);
  }
  if (latest) {
    const update = document.createElement("span");
    update.className = "task-update";
    update.textContent = progressLabel(latest);
    button.append(update);
  }
  button.onclick = () => selectTask(row.ID);
  li.append(button);
  return li;
}

function drawConversation(row, meta) {
  const messages = meta.conversation || [];
  const list = $("conversation");
  const signature = JSON.stringify([state.organizer, messages]);
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.replaceChildren(...messages.map((message, i) => {
      const item = document.createElement("li");
      item.dataset.speaker = message.role;
      const speaker = document.createElement("strong");
      speaker.textContent = message.role === "user" ? "You" : state.organizer;
      const content = document.createElement("p");
      content.textContent = message.text;
      if (i === messages.length - 1 && message.role === "muse") content.id = "latestQuestion";
      item.append(speaker, content);
      return item;
    }));
  }
  list.hidden = !messages.length;
  const needsReply = row.Status === "Waiting on User" && meta.awaitingReply === true && messages.at(-1)?.role === "muse";
  $("replyJump").hidden = !needsReply || state.advanced;
  $("replyJump").textContent = "Answer " + state.organizer;
  $("replyForm").hidden = !needsReply;
  $("replyLabel").textContent = "Reply to " + state.organizer;
  const input = $("replyInput");
  const turn = String(messages.length);
  if (input.dataset.task !== row.ID || input.dataset.turn !== turn) {
    input.dataset.task = row.ID;
    input.dataset.turn = turn;
    input.value = replyDrafts.get(row.ID) || "";
    $("replyStatus").textContent = "";
  }
  input.setAttribute("aria-describedby", needsReply ? "latestQuestion replyStatus" : "replyStatus");
  $("replyBtn").disabled = replyingTo !== null;
  $("replyBtn").textContent = replyingTo === row.ID ? "Sending…" : "Send reply";
  return needsReply ? messages.at(-1).text : null;
}

function drawDetail(row, children, relatedParent) {
  $("detailEmpty").hidden = Boolean(row);
  $("requestDetail").hidden = !row;
  $("runBtn").hidden = !row || row.Status !== "Open";
  $("runBtn").disabled = state.busy;
  $("auditRow").hidden = !(row && state.offers.some(o => o.row === row.ID));
  if (!row) { $("replyJump").hidden = true; return; }

  const { status, executor, meta } = describeTask(row);
  const openQuestion = drawConversation(row, meta);
  $("taskQuestion").textContent = row.Task;
  $("taskOwner").textContent = status + (executor ? " · " + agentLabel(executor) : "");
  $("taskOwner").dataset.status = status;
  const reply = meta.answer === openQuestion ? "" : meta.answer || "";
  $("taskReply").hidden = !reply;
  $("taskAnswer").textContent = reply;
  $("taskActivity").hidden = !meta.progress?.length;
  $("activityList").replaceChildren(...(meta.progress || []).flatMap(event => {
    const description = progressLabel(event);
    if (!description) return [];
    const item = document.createElement("li");
    item.textContent = description;
    if (event.at && Number.isFinite(Date.parse(event.at))) {
      const time = document.createElement("time");
      time.dateTime = event.at;
      time.textContent = new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      item.append(time);
    }
    return [item];
  }));
  $("parentTask").hidden = !relatedParent;
  if (relatedParent) {
    $("parentTask").textContent = "Back to original request";
    $("parentTask").onclick = () => selectTask(relatedParent);
  }
  $("relatedWork").hidden = !children.length;
  $("taskChildren").replaceChildren(...children.map(child => taskChoice(child)));
  $("inspectorPre").textContent =
    "ID: " + row.ID + "  |  Assigned to: " + row.To + "  |  Status: " + row.Status + "\\n\\n" + (row["Latest note"] || "");
  $("workCaption").hidden = status !== "Working" || motion.matches;
  if (status === "Working") {
    const caption = row.ID.charCodeAt(row.ID.length - 1) % captions.length;
    $("workCaption").textContent = captions[caption];
  }
}

function render() {
  const focusTask = document.activeElement?.dataset.taskId;
  document.body.dataset.mode = state.advanced ? "advanced" : "easy";
  $("modeBtn").textContent = state.advanced ? "Easy mode" : "Advanced mode";
  $("modeBtn").setAttribute("aria-pressed", String(state.advanced));
  $("routerBadge").textContent = "Organizer · " + state.organizer;
  $("requestInput").setAttribute("aria-label", captureMode ? "Tasks to save" : state.advanced ? "New task" : "Message " + state.organizer);
  $("organizerHint").textContent = captureMode
    ? "Say or type what’s on your mind, review one task per line, then save to your Google Sheet."
    : state.advanced
      ? "Choose an agent or add a task to your board."
      : "Say it or type it. " + state.organizer + " takes it from there.";
  $("addSheetTasksBtn").hidden = $("sheetTasksBtn").hidden = !state.sheetConnected;
  $("requestInput").placeholder = captureMode ? "One task per line…" : state.advanced ? "Describe the task…" : "What do you need?";
  $("boardSummary").textContent = state.tasks.filter(t => t.Status === "Open").length + " queued · " + state.tasks.filter(t => t.Status === "In progress").length + " working · " + state.tasks.filter(t => t.Status === "Waiting on User").length + " need you";
  const busy = state.busy || state.tasks.some(t => t.Status === "In progress");
  $("brandMark").src = busy && !motion.matches ? "/brand/loading.gif" : "/brand/logo.png";
  renderLanes();

  const children = new Map();
  const taskIds = new Set(state.tasks.map(row => row.ID));
  for (const row of state.tasks) {
    const meta = state.taskMeta[row.ID] || {};
    const parent = meta.handoffFrom;
    if (parent && parent !== row.ID && taskIds.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(row);
    }
  }
  const roots = state.tasks.filter(row => !taskIds.has(state.taskMeta[row.ID]?.handoffFrom));
  const groupState = row => {
    const pending = [row];
    const visited = new Set();
    const statuses = [];
    while (pending.length) {
      const task = pending.pop();
      if (visited.has(task.ID)) continue;
      visited.add(task.ID);
      statuses.push(describeTask(task));
      pending.push(...(children.get(task.ID) || []));
    }
    for (const status of ["Needs you", "Failed", "Working", "Queued"]) {
      const match = statuses.find(task => task.status === status);
      if (match) return match;
    }
    return statuses[0];
  };
  const groups = new Map(roots.map(row => [row.ID, groupState(row)]));
  const openRoots = roots.filter(row => groups.get(row.ID).status !== "Done");
  const completed = roots.filter(row => groups.get(row.ID).status === "Done");
  const visible = state.showCompleted ? [...openRoots, ...completed] : openRoots;
  if (!selectedTask()) state.selectedId = (state.advanced ? state.tasks[0] : visible[0])?.ID || null;
  $("completedToggle").hidden = state.advanced || !completed.length;
  $("completedToggle").setAttribute("aria-pressed", String(state.showCompleted));
  $("completedToggle").textContent = (state.showCompleted ? "Hide completed (" : "Show completed (") + completed.length + ")";
  $("firstTask").hidden = state.advanced ? state.tasks.length > 0 : visible.length > 0;
  $("firstTask").textContent = state.tasks.length ? "No active requests." : "Type a request above to get started.";
  $("easyBoard").hidden = state.advanced || !visible.length;
  $("easyBoard").replaceChildren(...(state.advanced ? [] : visible.map(row => taskChoice(row, groups.get(row.ID)))));
  $("boardTable").hidden = !state.advanced || !state.tasks.length;
  $("boardBody").replaceChildren(...(state.advanced ? state.tasks.map(row => {
    const tr = document.createElement("tr");
    if (row.ID === state.selectedId) tr.className = "selected";
    tr.onclick = () => selectTask(row.ID);
    const id = document.createElement("td");
    id.textContent = row.ID;
    const to = document.createElement("td");
    const stood = state.substitutions[row.ID];
    to.textContent = stood || row.To;
    if (stood) to.className = "sub";
    const status = document.createElement("td");
    status.textContent = row.Status;
    const task = document.createElement("td");
    const button = document.createElement("button");
    button.className = "text-button";
    button.dataset.taskId = row.ID;
    button.textContent = row.Task;
    button.setAttribute("aria-current", String(row.ID === state.selectedId));
    task.append(button);
    tr.append(id, to, status, task);
    return tr;
  }) : []));
  renderCrew();
  renderAsk();
  const row = selectedTask();
  const parent = row && state.taskMeta[row.ID]?.handoffFrom;
  drawDetail(row, children.get(state.selectedId) || [], taskIds.has(parent) ? parent : null);
  if (focusTask) {
    const control = [...document.querySelectorAll("[data-task-id]")].find(button => button.dataset.taskId === focusTask);
    control?.focus({ preventScroll: true });
  }

  const select = $("serviceSelect");
  if (!select.options.length && state.catalog.length) {
    state.catalog.forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.label + " — " + item.description;
      select.appendChild(opt);
    });
  }
}

async function addTask(taskText) {
  if (!taskText) return;
  const res = await post("/api/task", { task: taskText, to: state.activeLane === "board" ? null : state.activeLane, organize: !state.advanced });
  if (!res.ok) throw new Error(res.error || "Could not add your request.");
  $("technicalDetails").open = false;
  state.selectedId = res.task.ID;
  if (res.task.Status === "Done") state.showCompleted = true;
  setStatus("Request added to the board.");
  await refresh();
  render();
}

async function runSelected() {
  const sel = selectedTask();
  if (!sel || sel.Status !== "Open" || state.busy) return;
  setStatus("Running " + sel.ID + "…");
  state.busy = true;
  render();
  try {
    const data = await post("/api/run", { taskId: sel.ID });
    setStatus(data.ok ? "Board updated." : "Could not start this task. Check the board for its current status.");
  } catch { setStatus("Could not confirm the run. Check the board before trying again."); }
  finally { state.busy = false; render(); await refresh(); }
}

async function auditSelected() {
  const sel = selectedTask();
  if (!sel || !state.offers.some(o => o.row === sel.ID)) { setStatus("Nothing new to audit on this row."); return; }
  const res = await post("/api/audit", { row: sel.ID });
  setStatus(res.ok ? (res.requested ? "Sent to " + res.auditorLabel + " to check." : "One question first.") : res.error);
  await fetchState();
}

async function shareCurrent(target) {
  const sel = selectedTask();
  const content = sel ? (sel.ID + ": " + sel.Task) : "Shared from AI-first OS";
  const data = await post("/api/share", { target, content });
  setStatus(data.ok ? "Shared" + (data.boardRow ? " (" + data.boardRow.ID + ")" : "") : data.error);
  await fetchState();
}

async function openToday() {
  const t = await fetch("/api/today").then(r => r.json());
  $("todayHead").textContent = t.headline;
  const body = $("todayBody");
  body.replaceChildren();
  const addLine = (text, undo) => {
    const line = document.createElement("div");
    line.className = "line";
    const label = document.createElement("span");
    label.textContent = text;
    line.append(label);
    if (undo) {
      const b = document.createElement("button");
      b.textContent = undo.label;
      b.onclick = async () => {
        const res = await post("/api/undo", { row: undo.row, action: undo.action });
        setStatus(res.ok ? "Done." : res.error);
        await fetchState();
        openToday();
      };
      line.append(b);
    }
    body.append(line);
  };
  t.finished.forEach(f => addLine(f.by + " finished: " + f.task, t.undo.find(u => u.row === f.row)));
  t.waiting.forEach(w => addLine("Waiting on you: " + w.text));
  t.undo.filter(u => u.action === "withdraw").forEach(u => addLine("Still queued: " + u.row, u));
  if (!body.children.length) addLine("Nothing to show yet.");
  openDialog("todayModal");
}

let crewDrawn = "";
/** Organizer, first and second coding agent, first and second research agent, outside review. */
function renderCrew() {
  const crew = state.crew;
  const key = JSON.stringify(crew);
  if (!crew || key === crewDrawn) return;
  crewDrawn = key;
  const pick = (title, name, options, value, send, allowNone) => {
    const label = document.createElement("label");
    const select = document.createElement("select");
    select.setAttribute("aria-label", name);
    if (allowNone) select.append(new Option("None", ""));
    options.forEach(option => select.append(new Option(option.label, option.id)));
    select.value = value || "";
    select.onchange = async () => {
      const res = await post("/api/crew", send(select.value));
      setStatus(res.ok ? "Saved." : res.error || "Could not save that.");
      await fetchState();
    };
    label.append(title, select);
    return label;
  };
  const order = (role, index, value) => {
    const next = [...(crew.priorities[role] || [])];
    next[index] = value;
    return { role, order: next.filter(Boolean) };
  };
  const review = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = crew.outsideReview;
  box.onchange = async () => { await post("/api/crew", { outsideReview: box.checked }); await fetchState(); };
  review.append(box, "Outside review");
  const pair = (...items) => { const span = document.createElement("span"); span.className = "crew-pair"; span.append(...items); return span; };
  $("crewRow").replaceChildren(
    pick("Organizer", "Organizer", crew.choices.orchestrator, crew.organizer, value => ({ organizer: value })),
    pair(pick("Coding", "First coding agent", crew.choices.worker, crew.priorities.builder[0], value => order("builder", 0, value)),
      pick("then", "Second coding agent", crew.choices.worker, crew.priorities.builder[1], value => order("builder", 1, value), true)),
    pair(pick("Research", "First research agent", crew.choices.worker, crew.priorities.researcher[0], value => order("researcher", 0, value)),
      pick("then", "Second research agent", crew.choices.worker, crew.priorities.researcher[1], value => order("researcher", 1, value), true)),
    review,
  );
}

function openRoles() {
  const names = { orchestrator: "Orchestrator", builder: "Builder", auditor: "Auditor", researcher: "Researcher" };
  $("rolesBody").replaceChildren(...Object.keys(names).map(role => {
    const line = document.createElement("div");
    line.className = "line";
    const label = document.createElement("label");
    label.textContent = names[role];
    const select = document.createElement("select");
    select.setAttribute("aria-label", names[role]);
    (state.roleChoices[role] || []).forEach(c => {
      const o = document.createElement("option");
      o.value = c.id; o.textContent = c.label;
      select.append(o);
    });
    select.value = state.roles[role];
    select.onchange = async () => {
      const res = await post("/api/roles", { role, agent: select.value });
      setStatus(res.ok ? names[role] + " saved." : res.error);
      await fetchState();
    };
    line.append(label, select);
    return line;
  }));
  openDialog("rolesModal");
}

function showPhone({ text, link = null, button = null, onButton = null, spin = false }) {
  $("phoneSpin").src = spin && !motion.matches ? "/brand/loading.gif" : "/brand/logo.png";
  $("phoneSpin").hidden = !spin;
  $("phoneText").textContent = text;
  $("phoneLink").hidden = !link;
  $("phoneLink").value = link || "";
  $("phoneCopy").hidden = !link;
  $("phoneGo").hidden = !button;
  if (button) { $("phoneGo").textContent = button; $("phoneGo").onclick = onButton; }
}

const PHONE_READY = "Copy your private link and open it on your phone. Keep the link private.";

async function connectPhone(approveCost) {
  showPhone({ text: "Sign in to Supabase in the window that opened. Then this takes about two minutes.", spin: true });
  const res = await post("/api/phone/connect", { approveCost: approveCost === true })
    .catch(() => ({ ok: false, message: "Connection failed. Try again when the app is online." }));
  if (res.ok) showPhone({ text: PHONE_READY, link: res.link });
  else if (res.question) showPhone({ text: res.question, button: "Create it", onButton: () => connectPhone(true) });
  else showPhone({ text: res.message || "That did not work.", button: "Try again", onButton: () => connectPhone(false) });
}

async function openPhone() {
  openDialog("phoneModal");
  showPhone({ text: "Checking your phone connection…" });
  try {
    const s = await fetch("/api/phone").then(r => r.json());
    if (s.connected) showPhone({ text: PHONE_READY, link: s.link });
    else showPhone({ text: "Choose Connect my phone, sign in, then open your private link on your phone.", button: "Connect my phone", onButton: () => connectPhone(false) });
  } catch {
    showPhone({ text: "Could not check your connection.", button: "Try again", onButton: openPhone });
  }
}

$("phoneBtn").onclick = openPhone;
$("phoneCopy").onclick = async () => {
  await navigator.clipboard.writeText($("phoneLink").value);
  setStatus("Link copied.");
  $("phoneCopy").textContent = "Copied";
};
$("auditBtn").onclick = auditSelected;
$("connectBtn").onclick = async () => {
  const data = await post("/api/connect", { serviceId: $("serviceSelect").value });
  setStatus(data.ok ? "Connected " + data.connected.label : data.error);
  await fetchState();
};

function startVoiceCapture() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setStatus("Voice is not available in this window."); return; }
  const rec = new SR();
  rec.lang = navigator.language || "en-US";
  setStatus("Listening…");
  rec.onresult = async e => {
    const text = e.results[0][0].transcript;
    await post("/api/voice", { transcript: text, to: state.activeLane === "board" ? null : state.activeLane });
    setStatus("Heard: " + text);
    await fetchState();
  };
  rec.onerror = () => setStatus("Did not catch that.");
  rec.start();
}

function cycleTheme() {
  state.themeIdx = (state.themeIdx + 1) % state.themeKeys.length;
  applyTheme(state.themeKeys[state.themeIdx]);
}

$("voiceBtn").onclick = startVoiceCapture;
$("themeBtn").onclick = cycleTheme;
function openPalette() {
  if (!state.advanced) {
    ($("replyForm").hidden ? $("requestInput") : $("replyInput")).focus();
    return;
  }
  openDialog("paletteModal");
  $("quickTaskInput").focus();
}

window.addEventListener("keydown", e => {
  if (e.defaultPrevented || e.isComposing || anyModalOpen()) return;
  const focused = document.activeElement;
  const typing = focused?.matches("input, textarea, select, [contenteditable]");
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "k") {
    e.preventDefault();
    openPalette();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.code === "Space" && !focused?.matches("button, a, summary, [role=button]")) {
    e.preventDefault();
    openPalette();
    return;
  }
  if (key === "r") runSelected();
  if (key === "p") openPhone();
  if (!state.advanced) return;
  const lane = state.lanes.find(l => l.key === e.key);
  if (lane) { switchLane(lane.id); return; }
  if (["j", "k", "arrowdown", "arrowup"].includes(key)) {
    const index = state.tasks.findIndex(row => row.ID === state.selectedId);
    const offset = key === "j" || key === "arrowdown" ? 1 : -1;
    const next = Math.min(state.tasks.length - 1, Math.max(0, index + offset));
    if (state.tasks[next]) { e.preventDefault(); selectTask(state.tasks[next].ID); }
  }
  else if (key === "a") auditSelected();
  else if (key === "d") openToday();
  else if (key === "o") openRoles();
  else if (key === "s" || key === "c") openDialog("moreModal");
  else if (key === "v") startVoiceCapture();
  else if (key === "t") cycleTheme();
  else if (key === "n") { e.preventDefault(); openPalette(); }
});

async function sendReply() {
  const input = $("replyInput");
  const taskId = input.dataset.task;
  const draft = input.value;
  const text = draft.trim();
  if ($("replyForm").hidden || replyingTo || !taskId || !text) return;
  replyingTo = taskId;
  $("replyStatus").textContent = "";
  render();
  try {
    const result = await post("/api/reply", { taskId, text, turn: Number(input.dataset.turn) });
    if (!result.ok) throw new Error(result.error || "Could not send the reply.");
    if (replyDrafts.get(taskId) === draft) replyDrafts.delete(taskId);
    if (input.dataset.task === taskId && input.value === draft) input.value = "";
    setStatus("Reply sent.");
    await refresh();
  } catch (error) {
    if (input.dataset.task === taskId) $("replyStatus").textContent = "Reply kept. " + error.message;
    await refresh();
  } finally {
    replyingTo = null;
    render();
  }
}

async function checkAgents() {
  $("agentsStatus").textContent = "Checking installed AI services…";
  $("checkAgentsBtn").disabled = true;
  try {
    const res = await fetch("/api/agents").then(r => r.json());
    if (!res.ok) throw new Error("Could not check AI services.");
    $("agentsStatus").textContent = res.agents.some(agent => ["signed-in", "unverified"].includes(agent.state) && agent.headless)
      ? "Muse can try the available terminal agents below."
      : "No terminal agent is ready. Sign in or check again after a service limit resets.";
    $("agentList").replaceChildren(...res.agents.map(agent => {
      const row = document.createElement("div");
      row.className = "line";
      const name = document.createElement("strong");
      name.textContent = agent.label;
      const status = document.createElement("span");
      status.textContent = agent.state === "missing" ? "Not installed"
        : !agent.headless ? "Desktop app only"
        : agent.state === "signed-in" ? "Signed in"
        : agent.state === "unverified" ? "Sign-in detected"
        : agent.state === "cooldown" ? "Temporarily unavailable" : "Sign-in needed";
      row.append(name, status);
      if (agent.headless && agent.state === "installed") {
        const signIn = document.createElement("button");
        signIn.type = "button";
        signIn.textContent = "Sign in";
        signIn.setAttribute("aria-label", "Sign in to " + agent.label);
        signIn.onclick = async () => {
          signIn.disabled = true;
          try {
            const opened = await post("/api/intro/signin", { agent: agent.id });
            if (!opened.ok) throw new Error("Sign-in window did not open.");
            $("agentsStatus").textContent = "Finish signing in to " + agent.label + ", then choose Check again.";
          } catch {
            $("agentsStatus").textContent = "Could not open sign-in for " + agent.label + ".";
          } finally { signIn.disabled = false; }
        };
        row.append(signIn);
      }
      return row;
    }));
  } catch {
    $("agentsStatus").textContent = "Could not check AI services. Try again.";
  } finally {
    $("checkAgentsBtn").disabled = false;
  }
}

function setCaptureStatus(message) {
  $("captureStatus").textContent = message;
  $("captureStatus").hidden = !message;
}

function stopDictation(cancel = false) {
  if (!recognition) return;
  if (cancel) {
    const active = recognition;
    recognition = null;
    active.abort();
    $("voiceDumpBtn").textContent = "Voice dump";
    return;
  }
  recognition.stop();
  $("voiceDumpBtn").textContent = "Finishing…";
  setCaptureStatus("Finishing your transcript…");
}

function setCaptureMode(enabled) {
  if (capturePending || state.sending) return;
  if (!enabled) stopDictation(true);
  captureMode = enabled;
  $("addSheetTasksBtn").textContent = enabled ? "Back to " + state.organizer : "Add tasks";
  $("sendBtn").textContent = enabled ? "Save tasks" : "Send request";
  $("requestHelp").hidden = enabled;
  setCaptureStatus(enabled ? "Add one task per line, or say “next task” between ideas." : "");
  render();
  $("requestInput").focus();
}

function startTaskDictation() {
  if (capturePending || state.sending) return;
  if (recognition) {
    stopDictation();
    return;
  }
  const toSheet = state.sheetConnected;
  if (toSheet) setCaptureMode(true);
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setCaptureStatus(toSheet ? "Use your keyboard’s dictation or type one task per line." : "Use your keyboard’s dictation, or type.");
    $("requestInput").focus();
    return;
  }
  const rec = new SpeechRecognition();
  recognition = rec;
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = event => {
    if (recognition !== rec) return;
    let words = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) words += " " + event.results[i][0].transcript.trim();
    }
    if (!words.trim()) return;
    const input = $("requestInput");
    const transcript = words.replace(/\\bnext task\\b[.,:]*/gi, "\\n");
    input.value = (input.value + transcript).trimStart().slice(0, input.maxLength);
  };
  rec.onend = () => {
    if (recognition !== rec) return;
    recognition = null;
    $("voiceDumpBtn").textContent = "Voice dump";
    setCaptureStatus(toSheet ? "Review your transcript, then save your tasks." : "Press Enter to send.");
    if (!toSheet) $("requestInput").focus();
  };
  rec.onerror = () => {
    if (recognition !== rec) return;
    recognition = null;
    $("voiceDumpBtn").textContent = "Voice dump";
    setCaptureStatus(toSheet ? "Voice isn’t available here. Use keyboard dictation or type your tasks." : "Voice isn’t available here. Use keyboard dictation, or type.");
  };
  try {
    rec.start();
    $("voiceDumpBtn").textContent = "Stop listening";
    setCaptureStatus(toSheet ? "Listening. Say “next task” between ideas." : "Listening…");
  } catch {
    rec.onerror();
  }
}

async function saveCapturedTasks() {
  if (capturePending) return;
  if (recognition) {
    stopDictation();
    return;
  }
  const input = $("requestInput");
  const draft = input.value;
  const tasks = draft.split(/\\r?\\n/).map(task => task.trim()).filter(Boolean);
  if (!tasks.length) {
    setCaptureStatus("Enter at least one task.");
    return;
  }
  const payload = JSON.stringify(tasks);
  if (captureAttempt?.payload !== payload) captureAttempt = { payload, requestId: crypto.randomUUID() };
  capturePending = true;
  input.readOnly = true;
  $("sendBtn").disabled = true;
  $("addSheetTasksBtn").disabled = true;
  $("voiceDumpBtn").disabled = true;
  $("sendBtn").textContent = "Saving…";
  setCaptureStatus("Saving to your Google Sheet…");
  try {
    const response = await post("/api/sheet/tasks", { tasks, requestId: captureAttempt.requestId });
    if (!response.ok) throw new Error(response.error || "Could not save your tasks.");
    if (!Array.isArray(response.tasks) || response.tasks.length !== tasks.length ||
        response.tasks.some(task => !task?.id)) throw new Error("Could not verify all the saved tasks.");
    captureAttempt = null;
    if (input.value === draft) input.value = "";
    setCaptureStatus("Saved " + response.tasks.map(task => task.id).join(", ") + " to your Google Sheet. Add more whenever you’re ready.");
    input.focus();
  } catch (error) {
    setCaptureStatus(error.message + " Your draft is still here.");
  } finally {
    capturePending = false;
    input.readOnly = false;
    $("sendBtn").disabled = false;
    $("addSheetTasksBtn").disabled = false;
    $("voiceDumpBtn").disabled = false;
    $("sendBtn").textContent = "Save tasks";
  }
}

function selectSheetTask() {
  const task = sheetTasks.find(item => item.id === $("sheetTaskId").value);
  $("sheetTaskDescription").value = task?.task || "";
  $("sheetTaskStatus").value = task?.status || "";
}

async function loadSheetTasks() {
  if (sheetLoading || sheetUpdating) return;
  sheetLoading = true;
  $("sheetTasksRefresh").disabled = true;
  $("sheetTasksForm").hidden = true;
  $("sheetTasksStatus").textContent = "Checking your Google Sheet…";
  try {
    const response = await fetch("/api/sheet/tasks").then(r => r.json());
    if (!response.ok || !Array.isArray(response.tasks)) throw new Error(response.error || "Could not read your tasks.");
    sheetTasks = response.tasks;
    $("sheetTasksStatus").textContent = sheetTasks.length ? "" : "No tasks currently. Would you like to add some?";
    $("sheetTaskId").replaceChildren(...sheetTasks.map(task => {
      const option = document.createElement("option");
      option.value = task.id;
      option.textContent = task.id + " · " + task.task;
      return option;
    }));
    selectSheetTask();
    $("sheetTasksForm").hidden = !sheetTasks.length;
  } catch (error) {
    $("sheetTasksStatus").textContent = error.message;
  } finally {
    sheetLoading = false;
    $("sheetTasksRefresh").disabled = false;
  }
}

async function updateSheetTask() {
  if (sheetUpdating || sheetLoading) return;
  const selected = sheetTasks.find(item => item.id === $("sheetTaskId").value);
  if (!selected) return;
  const task = $("sheetTaskDescription").value.trim();
  const status = $("sheetTaskStatus").value;
  if (!task || !status) return;
  const input = { id: selected.id, task, status, revision: selected.revision };
  const payload = JSON.stringify(input);
  if (sheetUpdateAttempt?.payload !== payload) sheetUpdateAttempt = { payload, requestId: crypto.randomUUID() };
  sheetUpdating = true;
  const controls = [$("sheetTaskId"), $("sheetTaskDescription"), $("sheetTaskStatus"), $("updateSheetTaskBtn"), $("sheetTasksRefresh")];
  for (const control of controls) control.disabled = true;
  $("sheetTasksStatus").textContent = "Saving " + selected.id + "…";
  try {
    const response = await post("/api/sheet/tasks/update", { ...input, requestId: sheetUpdateAttempt.requestId });
    if (!response.ok) throw new Error(response.error || "Could not save the changes.");
    if (response.task?.id !== selected.id) throw new Error("Could not verify the saved changes.");
    sheetUpdateAttempt = null;
    if (response.task.status === "Done") {
      sheetTasks = sheetTasks.filter(task => task.id !== selected.id);
      $("sheetTaskId").selectedOptions[0]?.remove();
      selectSheetTask();
      $("sheetTasksForm").hidden = !sheetTasks.length;
    } else {
      sheetTasks = sheetTasks.map(item => item.id === selected.id ? response.task : item);
      $("sheetTaskId").selectedOptions[0].textContent = response.task.id + " · " + response.task.task;
    }
    $("sheetTasksStatus").textContent = "Saved " + response.task.id + " to your Google Sheet.";
  } catch (error) {
    $("sheetTasksStatus").textContent = error.message + " Your changes are still here.";
  } finally {
    sheetUpdating = false;
    for (const control of controls) control.disabled = false;
  }
}

async function submitRequest(input, dialog = null) {
  const draft = input.value;
  const text = draft.trim();
  if (!text || state.sending) return;
  state.sending = true;
  $("sendBtn").disabled = true;
  $("sendBtn").textContent = "Sending…";
  try {
    await addTask(text);
    if (input.value === draft) input.value = "";
    dialog?.close();
  } catch {
    setStatus("Could not send your request. Your draft is still here.");
  } finally {
    state.sending = false;
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Send request";
  }
}

$("modeBtn").onclick = () => { state.advanced = !state.advanced; state.activeLane = "board"; render(); };
$("runBtn").onclick = runSelected;
$("replyJump").onclick = () => $("replyInput").focus();
$("replyForm").onsubmit = e => { e.preventDefault(); sendReply(); };
$("replyInput").oninput = e => { replyDrafts.set(e.target.dataset.task, e.target.value); };
$("replyInput").onkeydown = e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("replyForm").requestSubmit();
  }
};
$("agentsBtn").onclick = () => { openDialog("agentsModal"); checkAgents(); };
$("checkAgentsBtn").onclick = checkAgents;
$("todayBtn").onclick = openToday;
$("rolesBtn").onclick = openRoles;
$("moreBtn").onclick = () => openDialog("moreModal");
$("completedToggle").onclick = () => { state.showCompleted = !state.showCompleted; render(); };
$("voiceDumpBtn").onclick = startTaskDictation;
$("addSheetTasksBtn").onclick = () => setCaptureMode(!captureMode);
$("sheetTasksBtn").onclick = () => { openDialog("sheetTasksModal"); loadSheetTasks(); };
$("sheetTasksRefresh").onclick = loadSheetTasks;
$("sheetTasksAdd").onclick = () => { $("sheetTasksModal").close(); setCaptureMode(true); };
$("sheetTaskId").onchange = selectSheetTask;
$("sheetTasksForm").onsubmit = e => { e.preventDefault(); updateSheetTask(); };
$("requestForm").onsubmit = e => {
  e.preventDefault();
  if (captureMode) saveCapturedTasks();
  else submitRequest($("requestInput"));
};
$("requestInput").onkeydown = e => {
  if (!captureMode && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("requestForm").requestSubmit();
  }
};
$("quickTaskInput").onkeydown = e => {
  if (e.key === "Enter" && !e.isComposing) submitRequest(e.target, $("paletteModal"));
};
for (const dialog of document.querySelectorAll("dialog")) {
  const modal = dialog.querySelector(".modal");
  const title = modal.querySelector("h3");
  title.id ||= dialog.id + "Title";
  dialog.setAttribute("aria-labelledby", title.id);
  const close = document.createElement("button");
  close.textContent = "Close";
  close.className = "modal-close";
  close.onclick = () => dialog.close();
  modal.append(close);
}
motion.addEventListener("change", () => {
  $("phoneSpin").src = motion.matches ? "/brand/logo.png" : "/brand/loading.gif";
  render();
});
if (!motion.matches) $("bootMark").src = "/brand/loading.gif";
async function refresh() {
  try {
    await fetchState();
    if (state.offline) setStatus("Board reconnected.");
    state.offline = false;
  } catch {
    if (!state.offline) setStatus("Connection lost. Reconnecting… Your unsent request is kept here.");
    state.offline = true;
  }
}
refresh().finally(() => { $("boot").hidden = true; });
setInterval(() => { if (!anyModalOpen()) refresh(); }, 4000);
</script>
</body>
</html>`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 256 * 1024) {
        reject(Object.assign(new Error("Too large"), { code: "TOO_LARGE" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Only this machine's own window may talk to this server. */
function isTrustedRequest(req) {
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  if (req.method === "POST" && !/^application\/json/i.test(String(req.headers["content-type"] || ""))) return false;
  return true;
}

function createDesktopServer({
  workspaceRoot = process.cwd(),
  manifest: initialManifest = null,
  board: initialBoard = null,
  notices: initialNotices = null,
  onSaveManifest,
  onIntroComplete = null,
  runner,
  detect = () => detectInstalledAgents({ workspaceRoot }),
  signIn = openSignInWindow,
  introOptions = {},
  phone = null,
  sheetTasks = null,
} = {}) {
  let manifest = initialManifest;
  let board = initialBoard;
  let sheetManifest;
  let sheetStore;
  function currentSheetTasks() {
    if (sheetTasks) return sheetTasks;
    if (sheetManifest !== manifest) {
      sheetStore = createSheetTasks({ manifest });
      sheetManifest = manifest;
    }
    return sheetStore;
  }

  let notices = initialNotices || (board ? createNoticeBook({ dir: path.dirname(board.jsonPath) }) : null);
  const save = next => {
    if (typeof onSaveManifest === "function") onSaveManifest(next);
  };

  function dispatchOptions() {
    return runner ? { runner, detect, availability: availabilityFromDetected(detect()), saveManifest: save } : { detect, saveManifest: save };
  }

  function availability() {
    return runner ? Object.fromEntries(HARNESSES.map(h => [h.id, true])) : availabilityFromDetected(detect());
  }

  /** First and second choice for a role. The first is always whoever holds the role today. */
  function crewOrder(role) {
    const saved = Array.isArray(manifest.priorities?.[role]) ? manifest.priorities[role] : [];
    return [...new Set([manifest.roles?.[role], ...saved].filter(Boolean))].slice(0, 2);
  }

  function defaultAssignee() {
    return manifest.roles?.builder || "claude";
  }

  function viewState() {
    const tasks = board.listTasks();
    const substitutions = Object.create(null);
    const taskMeta = Object.create(null);
    for (const row of tasks) {
      const meta = board.getMeta(row.ID);
      const { intent, kind, executor, answer, requestedAgent, handoffFrom } = meta;
      const progress = Array.isArray(meta.progress) ? meta.progress.slice(-20).map(({ stage, at, agent }) => ({ stage, at, agent })) : undefined;
      const conversation = Array.isArray(meta.conversation)
        ? meta.conversation.map(({ role, text }) => ({ role, text }))
        : undefined;
      taskMeta[row.ID] = {
        intent, kind, executor, progress, answer, requestedAgent, handoffFrom: handoffFrom || meta.auditOf || meta.fixOf,
        conversation, awaitingReply: meta.awaitingReply === true,
      };
      if (meta.substitutedFrom) substitutions[row.ID] = `${labelFor(meta.builder || row.To)} (for ${labelFor(meta.substitutedFrom)})`;
    }
    const harnessChoices = HARNESSES.map(h => ({ id: h.id, label: h.label }));
    return {
      ok: true,
      organizer: manifest.ideology?.routerFunnel || "Organizer",
      tasks,
      themes: THEMES,
      catalog: SERVICE_DROPDOWN_CATALOG,
      lanes: laneList(),
      notices: notices.listOpen(),
      offers: auditOffers(board),
      roles: manifest.roles || {},
      roleChoices: {
        orchestrator: [...PERSONAL_AGENTS.map(a => ({ id: a.id, label: a.label })), ...harnessChoices],
        builder: harnessChoices,
        auditor: harnessChoices,
        researcher: harnessChoices,
      },
      substitutions,
      taskMeta,
      crew: {
        organizer: manifest.roles?.orchestrator || "muse",
        priorities: {
          builder: crewOrder("builder"),
          researcher: crewOrder("researcher"),
        },
        outsideReview: manifest.settings?.autoAudit !== false,
        choices: {
          orchestrator: [...PERSONAL_AGENTS, ...HARNESSES].map(a => ({ id: a.id, label: a.label })),
          worker: HARNESSES.map(a => ({ id: a.id, label: a.label })),
        },
      },
      sheetConnected: currentSheetTasks().configured === true && !mirrorTarget(manifest),
      boardSheetUrl: mirrorTarget(manifest) ? manifest.board.sheets.url || null : null,
    };
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!isTrustedRequest(req)) {
        json(res, 403, { ok: false, error: "Forbidden" });
        return;
      }
      if (req.method === "GET" && Object.hasOwn(BRAND_FILES, req.url)) {
        const [name, type] = BRAND_FILES[req.url];
        res.writeHead(200, { "content-type": type, "cache-control": "max-age=3600" });
        res.end(fs.readFileSync(path.join(BRAND_DIR, name)));
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(manifest ? buildDesktopHtml() : buildIntroHtml());
        return;
      }

      if (req.method === "GET" && req.url === "/api/intro/state") {
        json(res, 200, buildIntroModel(detect(), { workspaceRoot, options: introOptions }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/intro/signin") {
        const body = await readJsonBody(req);
        const agent = detect().find(a => a.id === body.agent);
        if (!agent || agent.state !== "installed") {
          json(res, 200, { ok: false, error: "Only installed agents can sign in." });
          return;
        }
        json(res, 200, signIn(agent));
        return;
      }
      if (req.method === "POST" && req.url === "/api/intro/complete") {
        if (manifest) {
          json(res, 200, { ok: true, already: true });
          return;
        }
        const body = await readJsonBody(req);
        const made = await onIntroComplete({ selection: body, detected: detect() });
        manifest = made.manifest;
        board = made.board;
        notices = createNoticeBook({ dir: path.dirname(board.jsonPath) });
        json(res, 200, { ok: true });
        return;
      }

      if (!manifest) {
        json(res, 409, { ok: false, error: "Finish setup first." });
        return;
      }

      if (req.method === "GET" && req.url === "/api/state") {
        json(res, 200, viewState());
        return;
      }
      const listSheetTasks = req.method === "GET" && req.url === "/api/sheet/tasks";
      const writeSheetTasks = req.method === "POST" && ["/api/sheet/tasks", "/api/sheet/tasks/update"].includes(req.url);
      if (listSheetTasks || writeSheetTasks) {
        if (req.method === "POST" && req.headers.origin !== `http://${req.headers.host}`) {
          json(res, 403, { ok: false, error: "Open the app to save tasks." });
          return;
        }
        const store = currentSheetTasks();
        if (!store.configured) {
          json(res, 409, { ok: false, error: "Connect your Google Sheet first, then try again.", code: "SHEET_REQUIRED" });
          return;
        }
        if (listSheetTasks) {
          const tasks = await store.listOpen();
          json(res, 200, { ok: true, tasks });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (req.url === "/api/sheet/tasks") {
            const tasks = await store.add({ tasks: body.tasks, requestId: body.requestId, source: "desktop" });
            json(res, 200, { ok: true, tasks });
          } else {
            const task = await store.update({ id: body.id, task: body.task, status: body.status,
              revision: body.revision, requestId: body.requestId, source: "desktop" });
            json(res, 200, { ok: true, task });
          }
          return;
        }
      }
      if (req.method === "GET" && req.url === "/api/agents") {
        const detected = detect();
        const agents = HARNESSES.map(({ id, label }) => {
          const agent = detected.find(a => a.id === id);
          const state = agentCoolingDown(id) ? "cooldown"
            : agent?.signedIn && agent.authVerified === false ? "unverified" : agent?.state || "missing";
          return { id, label, state, headless: agent?.headless === true };
        });
        json(res, 200, { ok: true, agents });
        return;
      }
      if (req.method === "GET" && req.url === "/api/phone") {
        json(res, 200, phone ? phone.status(manifest) : { connected: false, link: null });
        return;
      }
      if (req.method === "POST" && req.url === "/api/phone/connect") {
        const body = await readJsonBody(req);
        json(res, 200, phone ? await phone.connect(manifest, { approveCost: body.approveCost === true }) : { ok: false, message: "Phone access is not available here." });
        return;
      }
      if (req.method === "GET" && req.url === "/api/today") {
        json(res, 200, buildDailySummary({ board, notices }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/undo") {
        const body = await readJsonBody(req);
        const row = applyUndo({ board, row: body.row, action: body.action, routerName: manifest.ideology?.routerFunnel });
        json(res, 200, { ok: true, row });
        return;
      }
      if (req.method === "POST" && req.url === "/api/answer") {
        const body = await readJsonBody(req);
        const result = answerNotice({
          noticeId: body.noticeId,
          value: body.value,
          digest: body.digest ?? null,
          source: "computer",
          notices,
          board,
          manifest,
          saveManifest: save,
          availability: availability(),
        });
        json(res, 200, { ok: true, ...result });
        return;
      }
      if (req.method === "POST" && req.url === "/api/reply") {
        const body = await readJsonBody(req);
        const task = replyToOrganizer({ taskId: body.taskId, text: body.text, turn: body.turn, board, manifest });
        json(res, 200, { ok: true, task });
        return;
      }
      if (req.method === "POST" && req.url === "/api/audit") {
        const body = await readJsonBody(req);
        const result = requestAudit({ board, manifest, buildRowId: body.row, availability: availability(), notices });
        json(res, 200, { ok: true, ...result, auditorLabel: result.auditor ? labelFor(result.auditor) : null });
        return;
      }
      if (req.method === "POST" && req.url === "/api/crew") {
        const body = await readJsonBody(req);
        const isWorker = id => HARNESSES.some(a => a.id === id);
        if (body.organizer !== undefined) {
          if (![...PERSONAL_AGENTS, ...HARNESSES].some(a => a.id === body.organizer)) return json(res, 400, { ok: false, error: "Unknown organizer." });
          manifest.roles = { ...(manifest.roles || {}), orchestrator: body.organizer };
          manifest.ideology = { ...(manifest.ideology || {}), routerFunnel: labelFor(body.organizer) };
        }
        if (body.role !== undefined) {
          const order = Array.isArray(body.order) ? [...new Set(body.order)].slice(0, 2) : [];
          if (!["builder", "researcher"].includes(body.role) || !order.length || !order.every(isWorker)) {
            return json(res, 400, { ok: false, error: "Pick a first choice." });
          }
          manifest.priorities = { ...(manifest.priorities || {}), [body.role]: order };
          manifest.roles = { ...(manifest.roles || {}), [body.role]: order[0] };
        }
        if (typeof body.outsideReview === "boolean") {
          manifest.settings = { ...(manifest.settings || {}), autoAudit: body.outsideReview };
        }
        save(manifest);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/api/roles") {
        const body = await readJsonBody(req);
        if (!["orchestrator", "builder", "auditor", "researcher"].includes(body.role)) {
          json(res, 400, { ok: false, error: "Unknown role." });
          return;
        }
        const allowed = [...HARNESSES, ...(body.role === "orchestrator" ? PERSONAL_AGENTS : [])].some(a => a.id === body.agent);
        if (!allowed) {
          json(res, 400, { ok: false, error: "Unknown agent." });
          return;
        }
        manifest.roles = { ...(manifest.roles || {}), [body.role]: body.agent };
        if (body.role === "orchestrator") manifest.ideology.routerFunnel = labelFor(body.agent);
        save(manifest);
        json(res, 200, { ok: true, roles: manifest.roles });
        return;
      }
      if (req.method === "POST" && req.url === "/api/task") {
        const body = await readJsonBody(req);
        if (typeof body.task !== "string" || !body.task.trim() || body.task.length > 16000) {
          json(res, 400, { ok: false, error: "Enter a request up to 16,000 characters." });
          return;
        }
        const task = body.task.trim();
        const added = body.organize === true
          ? queueOrganizerRequest({ task, board, manifest })
          : board.addTask({ task, to: body.to || defaultAssignee(), from: manifest.ideology?.routerFunnel || "Router" });
        json(res, 200, { ok: true, task: added });
        return;
      }
      if (req.method === "POST" && req.url === "/api/run") {
        const body = await readJsonBody(req);
        const result = await dispatchBoardTask({
          workspaceRoot,
          manifest,
          board,
          notices,
          taskId: body.taskId || null,
          ...dispatchOptions(),
        });
        json(res, 200, { ok: true, ...result });
        return;
      }
      if (req.method === "POST" && req.url === "/api/connect") {
        const body = await readJsonBody(req);
        const updated = connectServiceFromCatalog(manifest, body.serviceId, body);
        Object.assign(manifest, updated.manifest);
        save(manifest);
        json(res, 200, { ok: true, connected: updated.connected, manifest });
        return;
      }
      if (req.method === "POST" && req.url === "/api/share") {
        const body = await readJsonBody(req);
        const shared = shareToTarget({
          target: body.target || defaultAssignee(),
          content: body.content,
          workspaceRoot,
          vaultPath: manifest.vaultPath,
          board,
          routerName: manifest.ideology?.routerFunnel || "Router",
          dryRun: Boolean(body.dryRun),
        });
        json(res, 200, shared);
        return;
      }
      if (req.method === "POST" && req.url === "/api/voice") {
        const body = await readJsonBody(req);
        if (!body.transcript) {
          json(res, 200, { ok: false, error: "No transcript provided" });
          return;
        }
        const saved = saveVoiceDumpToInbox({
          vaultPath: manifest.vaultPath,
          transcript: body.transcript,
          routerName: manifest.ideology?.routerFunnel || "Router",
          board,
          autoQueueTo: body.to || defaultAssignee(),
        });
        json(res, 200, { ok: true, transcript: body.transcript, ...saved });
        return;
      }
      json(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message, code: err.code });
    }
  });

  return server;
}

function launchFramelessAppWindow(url, { platform = process.platform, spawnFn = spawn } = {}) {
  try {
    if (platform === "win32") {
      const child = spawnFn("cmd.exe", ["/c", "start", "", "msedge", `--app=${url}`], {
        detached: true,
        stdio: "ignore",
      });
      if (child && typeof child.unref === "function") child.unref();
      return true;
    }
    if (platform === "darwin") {
      const child = spawnFn("open", ["-n", "-a", "Google Chrome", "--args", `--app=${url}`], {
        detached: true,
        stdio: "ignore",
      });
      if (child && typeof child.unref === "function") child.unref();
      return true;
    }
    const child = spawnFn("xdg-open", [url], { detached: true, stdio: "ignore" });
    if (child && typeof child.unref === "function") child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  buildDesktopHtml,
  createDesktopServer,
  launchFramelessAppWindow,
  isTrustedRequest,
};
