#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  defaultProfileDir,
  profileFilePath,
  loadProfile,
  saveProfile,
  listAllProjects,
  resolveProject,
  stakesForProject,
  normalizeProfile,
} = require("../lib/v2/profile.cjs");
const { createStore } = require("../lib/v2/store.cjs");
const { createPipeline } = require("../lib/v2/pipeline.cjs");
const { detectHarnesses, listLiveModels } = require("../lib/v2/harnesses.cjs");
const { refreshModelCatalog, seedBaselineModels } = require("../lib/v2/model-catalog.cjs");
const { createDaemon } = require("../lib/v2/daemon.cjs");
const { createSecretVault } = require("../lib/v2/auth-broker.cjs");
const { detectGrokBot } = require("../lib/v2/connectors.cjs");
const { scanDirectoryForSecrets } = require("../lib/keyring.cjs");
const { installAutostart, removeAutostart, isAutostartInstalled, keepAlive } = require("../lib/autostart.cjs");
const { underTest } = require("../lib/harness-registry.cjs");

const CLI_PATH = __filename;

function parseArgs(argv) {
  const [cmd = "desktop", ...rest] = argv;
  const flags = {
    profileDir: process.env.AIOS_PROFILE_DIR || defaultProfileDir(),
    host: null,
    port: null,
    project: null,
    taskId: null,
    owner: null,
    vault: null,
    roots: [],
    tailscale: null,
    noWindow: false,
    json: false,
    refresh: false,
  };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--profile-dir" || a === "--dir") flags.profileDir = path.resolve(rest[++i] || flags.profileDir);
    else if (a === "--host") flags.host = rest[++i] || null;
    else if (a === "--port") flags.port = Number(rest[++i]);
    else if (a === "--project" || a === "-p") flags.project = rest[++i] || null;
    else if (a === "--task" || a === "--id") flags.taskId = rest[++i] || null;
    else if (a === "--owner") flags.owner = rest[++i] || null;
    else if (a === "--vault") flags.vault = rest[++i] || null;
    else if (a === "--root") { const r = rest[++i]; if (r) flags.roots.push(r); }
    else if (a === "--tailscale") flags.tailscale = rest[++i] || null;
    else if (a === "--no-window") flags.noWindow = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--refresh") flags.refresh = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  return { cmd, flags, positional };
}

function launchAppWindow(url, { platform = process.platform, spawnFn = spawn } = {}) {
  if (underTest()) return { launched: false, reason: "under-test" };
  try {
    if (platform === "win32") {
      const candidates = [
        path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
      ].filter(p => p && fs.existsSync(p));
      if (candidates.length) {
        const child = spawnFn(candidates[0], [`--app=${url}`], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref?.();
        return { launched: true, browser: candidates[0] };
      }
      const fallback = spawnFn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
      fallback.unref?.();
      return { launched: true, browser: "default" };
    }
    if (platform === "darwin") {
      const child = spawnFn("open", [url], { detached: true, stdio: "ignore" });
      child.unref?.();
      return { launched: true, browser: "open" };
    }
    const child = spawnFn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref?.();
    return { launched: true, browser: "xdg-open" };
  } catch (err) {
    return { launched: false, error: err.message };
  }
}

function runInitProfile({ profileDir = defaultProfileDir(), owner, vault, roots = [], tailscale } = {}) {
  const dir = path.resolve(profileDir);
  const current = loadProfile({ profileDir: dir });
  const next = normalizeProfile({
    ...current,
    ...(owner ? { owner } : {}),
    ...(vault ? { vaultPath: path.resolve(vault) } : {}),
    ...(roots.length ? { projectRoots: [...new Set([...(current.projectRoots || []), ...roots.map(r => path.resolve(r))])] } : {}),
    transport: {
      ...(current.transport || {}),
      ...(tailscale ? { tailscaleHost: tailscale } : {}),
    },
  });
  const savedPath = saveProfile(next, { profileDir: dir });
  return { ok: true, profilePath: savedPath, profile: next };
}

function runStatus({ profileDir = defaultProfileDir(), detect = detectHarnesses } = {}) {
  const dir = path.resolve(profileDir);
  const profile = loadProfile({ profileDir: dir });
  const store = createStore({ dbPath: path.join(dir, "os.db") });
  seedBaselineModels(store);
  try {
    const tasks = store.listTasks({ limit: 30 });
    const pendingApprovals = store.listOpenApprovals();
    const quotas = store.listQuotas();
    const models = store.listModels();
    const agents = detect({ workspaceRoot: dir });
    return {
      ok: true,
      owner: profile.owner,
      profileDir: dir,
      queuePaused: store.getQueueState().paused,
      counts: {
        active: tasks.filter(t => ["open", "running"].includes(t.status)).length,
        waiting: tasks.filter(t => t.status === "waiting").length,
        done: tasks.filter(t => t.status === "done").length,
        pendingApprovals: pendingApprovals.length,
      },
      tasks: tasks.slice(0, 15).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        stage: t.stage,
        project: t.projectName,
        stakes: t.stakes,
        updatedAt: t.updatedAt,
      })),
      pendingApprovals: pendingApprovals.map(a => ({ id: a.id, taskId: a.taskId, kind: a.kind, prompt: a.prompt })),
      agents: agents.map(a => ({
        id: a.id,
        label: a.label,
        installed: a.installed,
        signedIn: a.signedIn,
        headless: a.headless,
      })),
      quotas,
      modelsCount: models.length,
    };
  } finally {
    store.close();
  }
}

function runDoctor({ profileDir = defaultProfileDir(), detect = detectHarnesses, execProbe = spawnSync } = {}) {
  const dir = path.resolve(profileDir);
  const profilePath = profileFilePath(dir);
  const profile = loadProfile({ profileDir: dir });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const gitRes = execProbe("git", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 4000 });
  const gitOk = gitRes.status === 0;

  let sqliteOk = false;
  let storeDetail = "";
  try {
    const store = createStore({ dbPath: path.join(dir, "os.db") });
    store.listTasks({ limit: 1 });
    store.close();
    sqliteOk = true;
    storeDetail = path.join(dir, "os.db");
  } catch (err) {
    storeDetail = err.message;
  }

  const projects = listAllProjects(profile);
  const agents = detect({ workspaceRoot: dir });
  const grokbot = detectGrokBot();
  const vaultConfigured = Boolean(profile.vaultPath);
  const vaultOk = !vaultConfigured || fs.existsSync(profile.vaultPath);
  const secretScan = fs.existsSync(dir) ? scanDirectoryForSecrets(dir) : { clean: true, findings: [] };

  const checks = [
    { name: "node_22_plus", ok: nodeMajor >= 22, detail: process.versions.node },
    { name: "sqlite_store", ok: sqliteOk, detail: storeDetail },
    { name: "git_available", ok: gitOk, detail: (gitRes.stdout || "").trim() || "git not found" },
    { name: "profile_loaded", ok: true, detail: fs.existsSync(profilePath) ? profilePath : `${profilePath} (defaults)` },
    { name: "vault_ready", ok: vaultOk, detail: profile.vaultPath || "not configured" },
    { name: "projects_discovered", ok: true, detail: `${projects.length} project(s)` },
    { name: "agent_clis", ok: agents.some(a => a.installed && a.headless), detail: agents.filter(a => a.installed).map(a => a.id).join(", ") || "none installed" },
    { name: "secret_hygiene", ok: secretScan.clean, detail: secretScan.clean ? "clean" : `${secretScan.findings.length} finding(s)` },
  ];

  const criticalFailed = checks.filter(c => ["node_22_plus", "sqlite_store", "git_available", "secret_hygiene"].includes(c.name) && !c.ok);
  return {
    ok: criticalFailed.length === 0,
    owner: profile.owner,
    profilePath,
    checks,
    agents: agents.map(a => ({ id: a.id, label: a.label, installed: a.installed, signedIn: a.signedIn, headless: a.headless })),
    projectsCount: projects.length,
    connectors: {
      grokbot: { enabled: Boolean(profile.connectors?.grokbot?.enabled), installed: grokbot.installed, daemonDir: grokbot.daemonDir || null },
      muse: { enabled: Boolean(profile.connectors?.muse?.enabled) },
      sheetsSync: { enabled: Boolean(profile.connectors?.sheetsSync?.enabled) },
    },
  };
}

async function tryDaemonPost(profile, route, body, { returnErrors = false } = {}) {
  if (underTest()) return null;
  const port = profile.transport?.port || 4318;
  const url = `http://127.0.0.1:${port}${route}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok && (!returnErrors || res.status === 404)) return null;
    return await res.json();
  } catch (error) {
    if (returnErrors && error.name === "TimeoutError") throw error;
    return null;
  }
}

const HELP = [
  "AI-first OS v2",
  "",
  "  aios [desktop]               Start the unified daemon and open the OS UI",
  "  aios daemon | watch          Run the unified daemon headless (SSH/Tailscale/queue)",
  "  aios chat \"<text>\"           Send a request or reply to a task",
  "  aios wake <text|taskId>      Enqueue a request or resume a task",
  "  aios status [--json]         Show queue state, active work, CLIs, and quotas",
  "  aios logs <taskId> [--json]  Show thread, terminal agent bus, and delivery card",
  "  aios pause | resume          Pause or resume automatic task execution",
  "  aios models [--refresh]      List discovered models or run live canary discovery",
  "  aios phone [--json]          Print the direct phone pairing URL",
  "  aios doctor [--json]         Verify Node, SQLite, git, CLIs, vault, and hygiene",
  "  aios init [options]          Initialize or update ~/.aios/profile.json",
  "  aios autostart on|off|status Manage sign-in autostart",
  "  aios keep-alive              Crash-backoff supervisor for `aios daemon`",
  "",
  "Flags:",
  "  --profile-dir <path>         Use a custom state/profile directory (default: ~/.aios)",
  "  --host <addr> --port <num>   Override daemon bind host/port",
  "  --no-window                  Do not open a browser window on `aios desktop`",
  "  --project <name>             Explicitly target a repo on `chat` / `wake`",
  "  --task <id>                  Reply to an existing task on `chat`",
  "",
].join("\n");

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function formatStatus(report) {
  const lines = [
    `AI-first OS · ${report.owner} (${report.queuePaused ? "PAUSED" : "RUNNING"})`,
    `Tasks: ${report.counts.active} active · ${report.counts.waiting} waiting · ${report.counts.done} done · ${report.counts.pendingApprovals} pending approvals`,
    "",
    "Agents:",
    ...report.agents.map(a => `  - ${a.label.padEnd(13)} ${a.installed ? (a.signedIn ? "signed in" : "installed (sign-in needed)") : "not installed"}`),
  ];
  if (report.quotas.length) {
    lines.push("", "Quota Cooldowns:");
    for (const q of report.quotas) {
      lines.push(`  - ${q.provider}: ${q.reason}${q.resetAt ? ` (resets ${new Date(q.resetAt).toLocaleTimeString()})` : ""}`);
    }
  }
  if (report.tasks.length) {
    lines.push("", "Recent Tasks:");
    for (const t of report.tasks.slice(0, 8)) {
      lines.push(`  - ${t.id} [${t.status}]${t.project ? ` (${t.project})` : ""}: ${t.title}`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatDoctor(report) {
  const lines = [
    `AI-first OS Doctor · ${report.ok ? "OK" : "ISSUES FOUND"}`,
    `Profile: ${report.profilePath}`,
    "",
    ...report.checks.map(c => `  [${c.ok ? "OK" : "!!"}] ${c.name}: ${c.detail}`),
  ];
  return lines.join("\n") + "\n";
}

async function main(argv = process.argv.slice(2)) {
  const { cmd, flags, positional } = parseArgs(argv);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === "init") {
    const res = runInitProfile({
      profileDir: flags.profileDir,
      owner: flags.owner,
      vault: flags.vault,
      roots: flags.roots,
      tailscale: flags.tailscale,
    });
    printJson(res);
    return;
  }

  if (cmd === "doctor") {
    const report = runDoctor({ profileDir: flags.profileDir });
    if (flags.json) printJson(report);
    else process.stdout.write(formatDoctor(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "status") {
    const report = runStatus({ profileDir: flags.profileDir });
    if (flags.json) printJson(report);
    else process.stdout.write(formatStatus(report));
    return;
  }

  if (cmd === "models") {
    const profile = loadProfile({ profileDir: flags.profileDir });
    const store = createStore({ dbPath: path.join(flags.profileDir, "os.db") });
    seedBaselineModels(store);
    try {
      let report = null;
      if (flags.refresh) {
        const installed = detectHarnesses({ workspaceRoot: flags.profileDir }).filter(a => a.installed && a.headless).map(a => a.id);
        report = await refreshModelCatalog({
          store,
          profile,
          providers: installed,
          listModelsForProvider: provider => listLiveModels(provider),
        });
      }
      const models = store.listModels();
      if (flags.json) {
        printJson({ ok: true, report, models });
      } else {
        for (const m of models) {
          process.stdout.write(`${m.provider.padEnd(12)} ${m.tier.padEnd(10)} ${m.modelId.padEnd(28)} ${m.status}${m.isDefault ? " [default]" : ""}\n`);
        }
      }
    } finally {
      store.close();
    }
    return;
  }

  if (cmd === "pause" || cmd === "resume") {
    const profile = loadProfile({ profileDir: flags.profileDir });
    const paused = cmd === "pause";
    const remote = await tryDaemonPost(profile, paused ? "/api/v2/queue/pause" : "/api/v2/queue/resume", {});
    if (remote) {
      printJson(remote);
      return;
    }
    const store = createStore({ dbPath: path.join(flags.profileDir, "os.db") });
    try {
      const q = store.setQueuePaused(paused);
      printJson({ ok: true, queuePaused: q.paused });
    } finally {
      store.close();
    }
    return;
  }

  if (cmd === "chat" || cmd === "wake") {
    const text = positional.join(" ").trim();
    if (!text) throw new Error(`Usage: aios ${cmd} "<text>"`);
    const profile = loadProfile({ profileDir: flags.profileDir });
    const targetId = flags.taskId?.toUpperCase() || (cmd === "wake" && /^T\d+$/i.test(text) ? text.toUpperCase() : null);
    const action = cmd === "chat" ? "reply" : "continue";
    const route = targetId ? `/api/v2/tasks/${encodeURIComponent(targetId)}/${action}` : "/api/v2/tasks";
    const body = targetId
      ? (action === "reply" ? { text } : { note: flags.taskId ? text : null })
      : { text, projectName: flags.project || null };
    const remote = await tryDaemonPost(profile, route, body, { returnErrors: true });
    if (remote) {
      if (!remote.ok) throw new Error(remote.error || "The daemon rejected the message.");
      printJson(remote);
      return;
    }
    const store = createStore({ dbPath: path.join(flags.profileDir, "os.db") });
    try {
      if (targetId) {
        const pipeline = createPipeline({ store, getProfile: () => profile, profileDir: flags.profileDir });
        const updated = action === "reply"
          ? pipeline.replyToTask(targetId, { reply: text, source: "cli" })
          : pipeline.continueTask(targetId, { reply: body.note, source: "cli" });
        printJson({ ok: true, resumed: updated.id === targetId, task: updated });
      } else {
        const projects = listAllProjects(profile);
        const matched = resolveProject(flags.project || text, projects);
        const task = store.createTask({
          title: text.slice(0, 120),
          text,
          source: "cli",
          projectName: matched?.name || null,
          projectPath: matched?.path || null,
          stakes: matched ? stakesForProject(matched, profile) : "standard",
          status: "open",
        });
        printJson({ ok: true, created: true, task });
      }
    } finally {
      store.close();
    }
    return;
  }

  if (cmd === "logs") {
    const id = (flags.taskId || positional[0] || "").toUpperCase();
    if (!id) throw new Error("Usage: aios logs <taskId>");
    const store = createStore({ dbPath: path.join(flags.profileDir, "os.db") });
    try {
      const task = store.getTask(id);
      if (!task) throw new Error(`Task ${id} not found.`);
      const thread = store.getThread(id);
      const bus = store.getBusMessages(id);
      if (flags.json) {
        printJson({ ok: true, task, thread, bus });
      } else {
        process.stdout.write(`${task.id} · ${task.title} [${task.status} / ${task.stage}]\n`);
        process.stdout.write(`Project: ${task.projectName || "unassigned"} (${task.stakes})\n\n--- Thread ---\n`);
        for (const m of thread) process.stdout.write(`[${m.role}${m.agent ? "/" + m.agent : ""}] ${m.content}\n`);
        if (bus.length) {
          process.stdout.write("\n--- Terminal Agent Bus ---\n");
          for (const b of bus) process.stdout.write(`[${b.fromAgent} -> ${b.toAgent} (${b.msgType})] ${JSON.stringify(b.payload)}\n`);
        }
        if (task.delivery) {
          process.stdout.write(`\n--- Total Output ---\n${JSON.stringify(task.delivery, null, 2)}\n`);
        }
      }
    } finally {
      store.close();
    }
    return;
  }

  if (cmd === "phone") {
    const profile = loadProfile({ profileDir: flags.profileDir });
    const vault = createSecretVault();
    let phoneToken = vault.get("AIOS_V2_PHONE_TOKEN");
    if (!phoneToken) {
      phoneToken = require("node:crypto").randomBytes(24).toString("base64url");
      vault.set("AIOS_V2_PHONE_TOKEN", phoneToken);
    }
    const host = profile.transport?.tailscaleHost || "127.0.0.1";
    const port = flags.port || profile.transport?.port || 4318;
    const url = `http://${host}:${port}/#t=${encodeURIComponent(phoneToken)}`;
    if (flags.json) printJson({ ok: true, url, mode: profile.transport?.tailscaleHost ? "tailscale-direct" : "local" });
    else process.stdout.write(`Open on your phone (via Tailscale/LAN):\n${url}\n`);
    return;
  }

  if (cmd === "keep-alive") {
    keepAlive({ cliPath: CLI_PATH, profileDir: flags.profileDir });
    return;
  }

  if (cmd === "autostart") {
    const options = { cliPath: CLI_PATH, profileDir: flags.profileDir };
    if (positional[0] === "on") printJson(installAutostart(options));
    else if (positional[0] === "off") printJson(removeAutostart(options));
    else printJson({ installed: isAutostartInstalled(options) });
    return;
  }

  if (cmd === "desktop" || cmd === "daemon" || cmd === "watch") {
    const daemon = createDaemon({ profileDir: flags.profileDir });
    const started = await daemon.start({
      host: flags.host,
      port: Number.isFinite(flags.port) ? flags.port : null,
    });
    const profile = daemon.getProfile();
    process.stdout.write(`AI-first OS v2 running at ${started.url}\n`);
    if (profile.transport?.tailscaleHost) {
      process.stdout.write(`Phone (Tailscale): http://${profile.transport.tailscaleHost}:${started.port}/#t=${encodeURIComponent(started.phoneToken)}\n`);
    }
    if (cmd === "desktop" && !flags.noWindow) {
      launchAppWindow(started.url);
    }
    const stop = async () => {
      await daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  process.stdout.write(HELP);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  launchAppWindow,
  runInitProfile,
  runStatus,
  runDoctor,
  main,
};
