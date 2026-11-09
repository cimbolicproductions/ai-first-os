"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const { THEMES, SERVICE_DROPDOWN_CATALOG, connectServiceFromCatalog } = require("./service-catalog.cjs");
const { saveVoiceDumpToInbox, shareToTarget } = require("./voice-and-share.cjs");
const { dispatchBoardTask } = require("./os-runtime.cjs");

function buildDesktopHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AI-first OS</title>
<style>
  :root {
    --bg: #1a1b26; --panel: #24283b; --border: #414868;
    --text: #c0caf5; --muted: #565f89; --accent: #7aa2f7;
    --green: #9ece6a; --yellow: #e0af68; --red: #f7768e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }
  header {
    height: 36px; background: var(--panel); border-bottom: 2px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; padding: 0 12px;
    font-size: 12px;
  }
  .workspaces { display: flex; gap: 6px; }
  .ws-pill {
    padding: 3px 9px; border: 1px solid var(--border); cursor: pointer; border-radius: 3px;
    color: var(--muted); user-select: none;
  }
  .ws-pill.active { border-color: var(--accent); color: var(--bg); background: var(--accent); font-weight: 700; }
  .status-cluster { display: flex; gap: 12px; align-items: center; }
  .badge-green { color: var(--green); }
  .badge-yellow { color: var(--yellow); cursor: pointer; }
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
  tr:hover { background: rgba(255,255,255,0.04); cursor: pointer; }
  .lane-box { display: flex; flex-direction: column; gap: 10px; height: 100%; }
  pre {
    background: var(--bg); border: 1px solid var(--border); padding: 10px; border-radius: 4px;
    white-space: pre-wrap; font-size: 12px; flex: 1; overflow-y: auto;
  }
  footer {
    height: 30px; background: var(--panel); border-top: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; padding: 0 12px; font-size: 11px; color: var(--muted);
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
    width: 620px; max-width: 92vw; background: var(--panel); border: 2px solid var(--accent);
    border-radius: 6px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
  }
  input, select, button {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    padding: 8px 10px; font-family: inherit; font-size: 13px; border-radius: 4px;
  }
  button { background: var(--accent); color: var(--bg); font-weight: 700; cursor: pointer; border: none; }
  .cmd-list { display: flex; flex-direction: column; gap: 5px; max-height: 280px; overflow-y: auto; }
  .cmd-item {
    padding: 7px 10px; border: 1px solid var(--border); border-radius: 4px;
    display: flex; justify-content: space-between; cursor: pointer;
  }
  .cmd-item:hover { border-color: var(--accent); }
</style>
</head>
<body>
<header>
  <div class="workspaces" id="wsBar">
    <div class="ws-pill active" data-lane="board">[1] Board</div>
    <div class="ws-pill" data-lane="claude">[2] Claude</div>
    <div class="ws-pill" data-lane="codex">[3] Codex</div>
    <div class="ws-pill" data-lane="gemini">[4] Gemini</div>
    <div class="ws-pill" data-lane="agy">[5] Antigravity</div>
  </div>
  <div class="status-cluster">
    <span class="badge-green" id="routerBadge">● Router</span>
    <span class="badge-yellow" id="voiceBtn" title="Press V for Voice-to-Text">🎙️ [V] Voice Ready</span>
    <span class="badge-yellow" id="themeBtn" title="Press T to switch theme">🎨 [T] Theme</span>
  </div>
</header>

<main>
  <section class="tile focused" id="boardTile">
    <div class="tile-header">
      <span>SHARED TASK BOARD</span>
      <span><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>n</kbd> new · <kbd>r</kbd> run</span>
    </div>
    <div class="tile-body">
      <table>
        <thead><tr><th>ID</th><th>To</th><th>Status</th><th>Task</th></tr></thead>
        <tbody id="boardBody"></tbody>
      </table>
    </div>
  </section>

  <section class="tile" id="laneTile">
    <div class="tile-header">
      <span id="laneTitle">ACTIVE AGENT WORKSPACE</span>
      <span><kbd>s</kbd> Share to Agent · <kbd>c</kbd> Connect Dropdown</span>
    </div>
    <div class="tile-body lane-box">
      <div style="display:flex; gap:6px;">
        <select id="serviceSelect" style="flex:1;"></select>
        <button id="connectBtn">Connect</button>
      </div>
      <div style="display:flex; gap:6px;">
        <button onclick="shareCurrent('agy')">Share -> Antigravity</button>
        <button onclick="shareCurrent('claude')">Share -> Claude</button>
        <button onclick="shareCurrent('codex')">Share -> Codex</button>
        <button onclick="shareCurrent('gemini')">Share -> Gemini</button>
      </div>
      <pre id="inspectorPre">Select a row with j/k or press Ctrl+K / Space for Command Palette.</pre>
    </div>
  </section>
</main>

<footer>
  <div>
    <kbd>Ctrl+K</kbd> Palette · <kbd>1-5</kbd> Toggle AI · <kbd>N</kbd> New Task · <kbd>R</kbd> Run Task · <kbd>S</kbd> Share · <kbd>V</kbd> Voice-to-Text · <kbd>T</kbd> Theme
  </div>
  <div id="statusBar">AI-first OS Desktop Ready</div>
</footer>

<div class="modal-backdrop" id="paletteModal">
  <div class="modal">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <strong style="color:var(--accent)">COMMAND PALETTE</strong>
      <kbd>Esc</kbd>
    </div>
    <input id="quickTaskInput" placeholder="Type a task or voice-dump and press Enter to route to active agent..." />
    <div class="cmd-list" id="cmdList"></div>
  </div>
</div>

<script>
let state = { tasks: [], selectedIdx: 0, activeLane: "board", themes: {}, catalog: [], themeKeys: [], themeIdx: 0 };

async function fetchState() {
  const res = await fetch("/api/state");
  const data = await res.json();
  state.tasks = data.tasks || [];
  state.themes = data.themes || {};
  state.catalog = data.catalog || [];
  state.themeKeys = Object.keys(state.themes);
  document.getElementById("routerBadge").textContent = "● Router: " + (data.manifest?.ideology?.routerFunnel || "Router");
  render();
}

function applyTheme(key) {
  const t = state.themes[key];
  if (!t) return;
  const r = document.documentElement.style;
  r.setProperty("--bg", t.bg); r.setProperty("--panel", t.panel); r.setProperty("--border", t.border);
  r.setProperty("--text", t.text); r.setProperty("--muted", t.muted); r.setProperty("--accent", t.accent);
  r.setProperty("--green", t.green); r.setProperty("--yellow", t.yellow); r.setProperty("--red", t.red);
  setStatus("Theme: " + t.name);
}

function setStatus(msg) {
  document.getElementById("statusBar").textContent = msg;
}

function render() {
  document.querySelectorAll(".ws-pill").forEach(el => {
    el.classList.toggle("active", el.dataset.lane === state.activeLane);
  });
  document.getElementById("laneTitle").textContent = "WORKSPACE: " + state.activeLane.toUpperCase();

  const tbody = document.getElementById("boardBody");
  tbody.innerHTML = "";
  state.tasks.forEach((row, idx) => {
    const tr = document.createElement("tr");
    if (idx === state.selectedIdx) tr.className = "selected";
    tr.onclick = () => { state.selectedIdx = idx; render(); };
    tr.innerHTML = "<td><b>" + row.ID + "</b></td><td>" + row.To + "</td><td>" + row.Status + "</td><td>" + row.Task + "</td>";
    tbody.appendChild(tr);
  });

  const sel = state.tasks[state.selectedIdx];
  if (sel) {
    document.getElementById("inspectorPre").textContent =
      "ID: " + sel.ID + "  |  Owner: " + sel.To + "  |  Status: " + sel.Status + "\\n" +
      "Task: " + sel.Task + "\\n" +
      "Spec: " + (sel["Spec file"] || "none") + "\\n\\n" +
      "--- Latest Notes ---\\n" + (sel["Latest note"] || "");
  }

  const select = document.getElementById("serviceSelect");
  if (!select.options.length && state.catalog.length) {
    state.catalog.forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.label + " — " + item.description;
      select.appendChild(opt);
    });
  }
}

async function addTask(taskText, toAgent) {
  if (!taskText) return;
  await fetch("/api/task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: taskText, to: toAgent || (state.activeLane === "board" ? "claude" : state.activeLane) })
  });
  setStatus("Queued task on board -> " + (toAgent || state.activeLane));
  await fetchState();
}

async function runSelected() {
  const sel = state.tasks[state.selectedIdx];
  if (!sel) return;
  setStatus("Running " + sel.ID + " on " + sel.To + "...");
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: sel.ID })
  });
  const data = await res.json();
  setStatus("Completed " + sel.ID + " -> " + (data.status || "updated"));
  await fetchState();
}

async function shareCurrent(target) {
  const sel = state.tasks[state.selectedIdx];
  const content = sel ? (sel.ID + ": " + sel.Task + "\\n" + (sel["Latest note"] || "")) : "Shared from AI-first OS";
  const res = await fetch("/api/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, content })
  });
  const data = await res.json();
  setStatus("Shared to " + target.toUpperCase() + (data.boardRow ? " (" + data.boardRow.ID + ")" : ""));
  await fetchState();
}

document.getElementById("connectBtn").onclick = async () => {
  const serviceId = document.getElementById("serviceSelect").value;
  const res = await fetch("/api/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serviceId })
  });
  const data = await res.json();
  setStatus("Connected " + (data.connected?.label || serviceId) + " into aios.yaml");
  await fetchState();
};

function startVoiceCapture() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const rec = new SR();
    rec.lang = "en-US";
    setStatus("🎙️ Listening (speak your task or brain dump)...");
    rec.onresult = async (e) => {
      const text = e.results[0][0].transcript;
      await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text, to: state.activeLane === "board" ? "claude" : state.activeLane })
      });
      setStatus("🎙️ Voice routed: " + text);
      await fetchState();
    };
    rec.start();
  } else {
    fetch("/api/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      .then(r => r.json())
      .then(d => { setStatus(d.transcript ? "🎙️ " + d.transcript : (d.error || "Voice capture finished")); fetchState(); });
  }
}

document.getElementById("voiceBtn").onclick = startVoiceCapture;
document.getElementById("themeBtn").onclick = () => {
  state.themeIdx = (state.themeIdx + 1) % state.themeKeys.length;
  applyTheme(state.themeKeys[state.themeIdx]);
};

document.getElementById("quickTaskInput").addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && e.target.value.trim()) {
    await addTask(e.target.value.trim());
    e.target.value = "";
    document.getElementById("paletteModal").classList.remove("open");
  }
});

window.addEventListener("keydown", (e) => {
  const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if ((e.ctrlKey && e.key.toLowerCase() === "k") || (!inInput && e.code === "Space")) {
    e.preventDefault();
    const m = document.getElementById("paletteModal");
    m.classList.toggle("open");
    if (m.classList.contains("open")) document.getElementById("quickTaskInput").focus();
    return;
  }
  if (e.key === "Escape") {
    document.getElementById("paletteModal").classList.remove("open");
    return;
  }
  if (inInput) return;
  if (["1","2","3","4","5"].includes(e.key)) {
    const map = { "1": "board", "2": "claude", "3": "codex", "4": "gemini", "5": "agy" };
    state.activeLane = map[e.key];
    render();
  } else if (e.key === "j" || e.key === "ArrowDown") {
    state.selectedIdx = Math.min(state.tasks.length - 1, state.selectedIdx + 1);
    render();
  } else if (e.key === "k" || e.key === "ArrowUp") {
    state.selectedIdx = Math.max(0, state.selectedIdx - 1);
    render();
  } else if (e.key.toLowerCase() === "r") {
    runSelected();
  } else if (e.key.toLowerCase() === "v") {
    startVoiceCapture();
  } else if (e.key.toLowerCase() === "t") {
    state.themeIdx = (state.themeIdx + 1) % state.themeKeys.length;
    applyTheme(state.themeKeys[state.themeIdx]);
  } else if (e.key.toLowerCase() === "n") {
    const m = document.getElementById("paletteModal");
    m.classList.add("open");
    document.getElementById("quickTaskInput").focus();
  }
});

fetchState();
</script>
</body>
</html>`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function createDesktopServer({
  workspaceRoot = process.cwd(),
  manifest,
  board,
  onSaveManifest,
  runner,
} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(buildDesktopHtml());
        return;
      }
      if (req.method === "GET" && req.url === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            manifest,
            tasks: board.listTasks(),
            themes: THEMES,
            catalog: SERVICE_DROPDOWN_CATALOG,
          })
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/task") {
        const body = await readJsonBody(req);
        const added = board.addTask({
          task: body.task,
          to: body.to || "claude",
          from: manifest.ideology?.routerFunnel || "Router",
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: added }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/run") {
        const body = await readJsonBody(req);
        const result = await dispatchBoardTask({
          workspaceRoot,
          manifest,
          board,
          taskId: body.taskId || null,
          runner,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/connect") {
        const body = await readJsonBody(req);
        const updated = connectServiceFromCatalog(manifest, body.serviceId, body);
        Object.assign(manifest, updated.manifest);
        if (typeof onSaveManifest === "function") onSaveManifest(manifest);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, connected: updated.connected, manifest }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/share") {
        const body = await readJsonBody(req);
        const shared = shareToTarget({
          target: body.target || "agy",
          content: body.content,
          workspaceRoot,
          vaultPath: manifest.vaultPath,
          board,
          routerName: manifest.ideology?.routerFunnel || "Router",
          dryRun: Boolean(body.dryRun),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(shared));
        return;
      }
      if (req.method === "POST" && req.url === "/api/voice") {
        const body = await readJsonBody(req);
        if (body.transcript) {
          const saved = saveVoiceDumpToInbox({
            vaultPath: manifest.vaultPath,
            transcript: body.transcript,
            routerName: manifest.ideology?.routerFunnel || "Router",
            board,
            autoQueueTo: body.to || "claude",
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, transcript: body.transcript, ...saved }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "No transcript provided" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, code: err.code }));
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
};
