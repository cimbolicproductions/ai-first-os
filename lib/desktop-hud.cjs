"use strict";

const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { THEMES, SERVICE_DROPDOWN_CATALOG, connectServiceFromCatalog } = require("./service-catalog.cjs");
const { saveVoiceDumpToInbox, shareToTarget } = require("./voice-and-share.cjs");
const { dispatchBoardTask, answerNotice } = require("./os-runtime.cjs");
const { detectInstalledAgents, openSignInWindow } = require("./agent-auth.cjs");
const { HARNESSES, PERSONAL_AGENTS, labelFor, laneList } = require("./harness-registry.cjs");
const { availabilityFromDetected } = require("./roles.cjs");
const { createNoticeBook } = require("./notices.cjs");
const { auditOffers, requestAudit } = require("./audit-loop.cjs");
const { buildDailySummary, applyUndo } = require("./daily-summary.cjs");
const { buildIntroModel } = require("./first-run.cjs");
const { buildIntroHtml } = require("./first-run-page.cjs");

function buildDesktopHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AI-first OS</title>
<style>
  :root {
    --bg: #1a1b26; --panel: #24283b; --border: #414868;
    --text: #c0caf5; --muted: #8089b3; --accent: #7aa2f7;
    --green: #9ece6a; --yellow: #e0af68; --red: #f7768e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  [hidden] { display: none !important; }
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
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.68);
    display: none; align-items: center; justify-content: center; z-index: 50;
  }
  .modal-backdrop.open { display: flex; }
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
</style>
</head>
<body>
<header>
  <div class="workspaces" id="wsBar"></div>
  <div class="status-cluster">
    <span class="badge-green" id="routerBadge"></span>
    <button class="badge-yellow" id="voiceBtn">[V] Voice</button>
    <button class="badge-yellow" id="themeBtn">[T] Theme</button>
  </div>
</header>

<div id="askBar" hidden role="alert"><span id="askText"></span><div id="askChoices"></div></div>

<main>
  <section class="tile focused">
    <div class="tile-header">
      <span>SHARED TASK BOARD</span>
      <span><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>n</kbd> new · <kbd>r</kbd> run</span>
    </div>
    <div class="tile-body">
      <div id="firstTask" hidden>What should your agents do first?<br>Press <kbd>n</kbd> and say it.</div>
      <table id="boardTable">
        <thead><tr><th>ID</th><th>To</th><th>Status</th><th>Task</th></tr></thead>
        <tbody id="boardBody"></tbody>
      </table>
    </div>
  </section>

  <section class="tile">
    <div class="tile-header">
      <span id="laneTitle"></span>
      <span><kbd>a</kbd> Audit · <kbd>d</kbd> Today · <kbd>o</kbd> Roles · <kbd>s</kbd> Share</span>
    </div>
    <div class="tile-body lane-box">
      <div class="btn-row" id="auditRow" hidden><button id="auditBtn">Audit</button></div>
      <pre id="inspectorPre">Pick a row with j/k, or press Space to add a task.</pre>
    </div>
  </section>
</main>

<footer>
  <div><kbd>Space</kbd> New task · <kbd>1-6</kbd> Switch agent · <kbd>R</kbd> Run · <kbd>A</kbd> Audit · <kbd>D</kbd> Today · <kbd>V</kbd> Voice</div>
  <div id="statusBar" role="status">Ready</div>
</footer>

<div class="modal-backdrop" id="paletteModal">
  <div class="modal">
    <h3>NEW TASK</h3>
    <input id="quickTaskInput" aria-label="New task" placeholder="Say what you need and press Enter" />
  </div>
</div>

<div class="modal-backdrop" id="moreModal">
  <div class="modal">
    <h3>SHARE THIS ROW</h3>
    <div class="btn-row" id="shareRow"></div>
    <h3>CONNECT A SERVICE</h3>
    <div class="btn-row">
      <select id="serviceSelect" aria-label="Service"></select>
      <button id="connectBtn">Connect</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="todayModal">
  <div class="modal"><h3 id="todayHead"></h3><div id="todayBody"></div></div>
</div>

<div class="modal-backdrop" id="rolesModal">
  <div class="modal"><h3>WHO DOES WHAT</h3><div id="rolesBody"></div></div>
</div>

<script>
const state = { tasks: [], selectedIdx: 0, activeLane: "board", themes: {}, catalog: [], themeKeys: [], themeIdx: 0, lanes: [], notices: [], offers: [], roles: {}, roleChoices: {}, substitutions: {} };
const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(r => r.json());
const setStatus = msg => { $("statusBar").textContent = msg; };
const anyModalOpen = () => document.querySelector(".modal-backdrop.open");
function closeModals() { document.querySelectorAll(".modal-backdrop.open").forEach(m => m.classList.remove("open")); }

async function fetchState() {
  const data = await fetch("/api/state").then(r => r.json());
  Object.assign(state, {
    tasks: data.tasks || [], themes: data.themes || {}, catalog: data.catalog || [], themeKeys: Object.keys(data.themes || {}),
    lanes: data.lanes || [], notices: data.notices || [], offers: data.offers || [], roles: data.roles || {}, roleChoices: data.roleChoices || {}, substitutions: data.substitutions || {},
  });
  $("routerBadge").textContent = "Orchestrator: " + (data.manifest?.ideology?.routerFunnel || "Router");
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
  $("laneTitle").textContent = "WORKSPACE: " + (lane ? lane.label.toUpperCase() : "");
  const share = state.lanes.filter(l => l.id !== "board").map(l => {
    const b = document.createElement("button");
    b.textContent = "Share to " + l.label;
    b.onclick = () => shareCurrent(l.id);
    return b;
  });
  $("shareRow").replaceChildren(...share);
}

function renderAsk() {
  const n = state.notices.find(x => x.choices && x.choices.length);
  $("askBar").hidden = !n;
  if (!n) return;
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

function render() {
  renderLanes();
  renderAsk();
  $("firstTask").hidden = state.tasks.length > 0;
  $("boardTable").hidden = state.tasks.length === 0;
  const rows = state.tasks.map((row, idx) => {
    const tr = document.createElement("tr");
    if (idx === state.selectedIdx) tr.className = "selected";
    tr.onclick = () => { state.selectedIdx = idx; render(); };
    const stood = state.substitutions[row.ID];
    const to = document.createElement("td");
    to.textContent = stood ? stood : row.To;
    if (stood) to.className = "sub";
    const id = document.createElement("td"); id.textContent = row.ID;
    const status = document.createElement("td"); status.textContent = row.Status;
    const task = document.createElement("td"); task.textContent = row.Task;
    tr.append(id, to, status, task);
    return tr;
  });
  $("boardBody").replaceChildren(...rows);

  const sel = state.tasks[state.selectedIdx];
  if (sel) {
    $("inspectorPre").textContent =
      "ID: " + sel.ID + "  |  Owner: " + sel.To + "  |  Status: " + sel.Status + "\\n" +
      "Task: " + sel.Task + "\\n\\n" + (sel["Latest note"] || "");
  }
  $("auditRow").hidden = !(sel && state.offers.some(o => o.row === sel.ID));

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
  const res = await post("/api/task", { task: taskText, to: state.activeLane === "board" ? null : state.activeLane });
  setStatus(res.ok ? "On the board: " + res.task.ID : res.error);
  await fetchState();
}

async function runSelected() {
  const sel = state.tasks[state.selectedIdx];
  if (!sel) return;
  setStatus("Running " + sel.ID + "…");
  const data = await post("/api/run", { taskId: sel.ID });
  setStatus(sel.ID + ": " + (data.status || data.error || "updated"));
  await fetchState();
}

async function auditSelected() {
  const sel = state.tasks[state.selectedIdx];
  if (!sel || !state.offers.some(o => o.row === sel.ID)) { setStatus("Nothing new to audit on this row."); return; }
  const res = await post("/api/audit", { row: sel.ID });
  setStatus(res.ok ? (res.requested ? "Sent to " + res.auditorLabel + " to check." : "One question first.") : res.error);
  await fetchState();
}

async function shareCurrent(target) {
  const sel = state.tasks[state.selectedIdx];
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
  $("todayModal").classList.add("open");
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
  $("rolesModal").classList.add("open");
}

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
$("quickTaskInput").addEventListener("keydown", async e => {
  if (e.key === "Enter" && e.target.value.trim()) {
    const text = e.target.value.trim();
    e.target.value = "";
    closeModals();
    await addTask(text);
  }
});

function openPalette() {
  $("paletteModal").classList.add("open");
  $("quickTaskInput").focus();
}

window.addEventListener("keydown", e => {
  const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (e.key === "Escape") { closeModals(); return; }
  if ((e.ctrlKey && e.key.toLowerCase() === "k") || (!inInput && e.code === "Space" && !anyModalOpen())) {
    e.preventDefault();
    openPalette();
    return;
  }
  if (inInput || anyModalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
  const lane = state.lanes.find(l => l.key === e.key);
  if (lane) { switchLane(lane.id); return; }
  const key = e.key.toLowerCase();
  if (key === "j" || e.key === "ArrowDown") { state.selectedIdx = Math.min(state.tasks.length - 1, state.selectedIdx + 1); render(); }
  else if (key === "k" || e.key === "ArrowUp") { state.selectedIdx = Math.max(0, state.selectedIdx - 1); render(); }
  else if (key === "r") runSelected();
  else if (key === "a") auditSelected();
  else if (key === "d") openToday();
  else if (key === "o") openRoles();
  else if (key === "s" || key === "c") { $("moreModal").classList.add("open"); }
  else if (key === "v") startVoiceCapture();
  else if (key === "t") cycleTheme();
  else if (key === "n") { e.preventDefault(); openPalette(); }
});

fetchState();
setInterval(() => { if (!anyModalOpen()) fetchState(); }, 4000);
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
  detect = detectInstalledAgents,
  signIn = openSignInWindow,
  introOptions = {},
} = {}) {
  let manifest = initialManifest;
  let board = initialBoard;
  let notices = initialNotices || (board ? createNoticeBook({ dir: path.dirname(board.jsonPath) }) : null);
  const save = next => {
    if (typeof onSaveManifest === "function") onSaveManifest(next);
  };

  function dispatchOptions() {
    return runner ? { runner } : {};
  }

  function availability() {
    return runner ? Object.fromEntries(HARNESSES.map(h => [h.id, true])) : availabilityFromDetected(detect());
  }

  function defaultAssignee() {
    return manifest.roles?.builder || "claude";
  }

  function viewState() {
    const tasks = board.listTasks();
    const substitutions = {};
    for (const row of tasks) {
      const meta = board.getMeta(row.ID);
      if (meta.substitutedFrom) substitutions[row.ID] = `${labelFor(meta.builder || row.To)} (for ${labelFor(meta.substitutedFrom)})`;
    }
    const harnessChoices = HARNESSES.map(h => ({ id: h.id, label: h.label }));
    return {
      ok: true,
      manifest,
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
    };
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!isTrustedRequest(req)) {
        json(res, 403, { ok: false, error: "Forbidden" });
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
      if (req.method === "POST" && req.url === "/api/audit") {
        const body = await readJsonBody(req);
        const result = requestAudit({ board, manifest, buildRowId: body.row, availability: availability(), notices });
        json(res, 200, { ok: true, ...result, auditorLabel: result.auditor ? labelFor(result.auditor) : null });
        return;
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
        const added = board.addTask({
          task: body.task,
          to: body.to || defaultAssignee(),
          from: manifest.ideology?.routerFunnel || "Router",
        });
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
