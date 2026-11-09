#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { detectInstalledAgents, cachedDetect, runInteractiveSignIn } = require("../lib/agent-auth.cjs");
const { bootstrapVault } = require("../lib/vault-bootstrap.cjs");
const { resolveSkillsPath } = require("../lib/vault-options.cjs");
const { renderAgentInstructions } = require("../lib/ideology.cjs");
const { validateSecretName, checkSecretExists, scanDirectoryForSecrets, readSecret, storeSecret } = require("../lib/keyring.cjs");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { dispatchBoardTask, answerNotice } = require("../lib/os-runtime.cjs");
const { startTui } = require("../lib/shell-tui.cjs");
const { createDesktopServer, launchFramelessAppWindow } = require("../lib/desktop-hud.cjs");
const { connectServiceFromCatalog, SERVICE_DROPDOWN_CATALOG } = require("../lib/service-catalog.cjs");
const { captureVoiceNative, saveVoiceDumpToInbox, shareToTarget } = require("../lib/voice-and-share.cjs");
const { toSimpleYaml, loadManifest, saveManifest, getSetting, setSetting } = require("../lib/workspace.cjs");
const { HARNESSES, PERSONAL_AGENTS, labelFor } = require("../lib/harness-registry.cjs");
const { availabilityFromDetected, buildRoleSlate } = require("../lib/roles.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { requestAudit, auditOffers } = require("../lib/audit-loop.cjs");
const { buildDailySummary, applyUndo } = require("../lib/daily-summary.cjs");
const { buildIntroModel, profileFromIntro, runTerminalIntro } = require("../lib/first-run.cjs");
const { startHomeServices } = require("../lib/home-service.cjs");
const { installAutostart, removeAutostart, isAutostartInstalled, keepAlive } = require("../lib/autostart.cjs");
const { connectBackend, SECRET_NAMES } = require("../lib/backend-provision.cjs");
const { newToken, buildPhoneLink } = require("../lib/cloud-link.cjs");

const CLI_PATH = __filename;
const NEEDS_SETUP = "AI-first OS is not set up here yet. Run `node bin/aios.cjs` first.";

function loadProductConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "product.json"), "utf8"));
  } catch {
    return {};
  }
}

function buildManifestFromProfile(profile, workspaceRoot) {
  const machines = {
    primary: {
      os: process.platform,
      role: "project-data-and-local-builds",
      workspace: workspaceRoot,
    },
  };
  if (profile.workStyle === "hybrid-hub-and-mobile") {
    machines["always-on-hub"] = {
      os: profile.hubOs || "macos",
      role: "always-on-workers",
      agents: profile.agents?.builders || ["claude", "codex"],
    };
  }

  const builders = profile.agents?.builders || ["claude", "codex"];
  const researchers = profile.agents?.researchers || ["gemini"];
  const connections = {
    github: {
      type: "mcp",
      agents: [...builders, ...researchers],
      secretName: "GITHUB_TOKEN",
    },
    ...(profile.connections || {}),
  };

  const roles =
    profile.roleSlate ||
    buildRoleSlate({ orchestrator: profile.routerName || "router", builder: builders[0], auditor: builders[1], researcher: researchers[0] });
  const vaultPath = path.resolve(workspaceRoot, profile.vaultPath || "./ContextVault");

  return {
    name: "ai-first-os",
    version: 1,
    owner: profile.userName || "User",
    primaryGoal: profile.primaryGoal || "Ship high-leverage work",
    vaultPath,
    skillsPath: resolveSkillsPath({ pick: profile.skillsPick, customPath: profile.skillsCustomPath, vaultPath, options: profile.obsidianOptions }),
    vault: { obsidian: profile.obsidian === true },
    board: {
      mode: profile.boardMode || "local",
      canonicalAuthority: profile.boardMode === "sheets" ? "google-sheet" : "local-json",
      writeRule: "by-column-name-never-position",
      ...(profile.sheetsConfig ? { sheets: profile.sheetsConfig } : { localDir: path.resolve(workspaceRoot, "./board") }),
    },
    ideology: {
      routerFunnel: profile.routerName || "Router",
      oneOwnerPerRow: true,
      claimFirst: true,
      buildStraightThrough: true,
      hardGates: [
        "any_spend_of_any_amount",
        "external_sends",
        "public_submissions",
        "refunds_or_billing_changes",
      ],
      untrustedBoardProse: true,
      untrustedDoorbellEvents: true,
      cloudScheduledRuns: "read-and-report-only-for-local-code",
      maxAutomaticStartsPerDay: profile.maxAutomaticStartsPerDay || 6,
    },
    machines,
    roles,
    models: profile.models || {},
    settings: {},
    summary: { morningPush: false, hour: 8 },
    firstRun: { completed: true },
    agents: {
      [String(profile.routerName || "router").toLowerCase()]: { role: "organize", managedBy: "router" },
      ...Object.fromEntries(builders.map(a => [a, { role: "build" }])),
      ...Object.fromEntries(researchers.map(a => [a, { role: "research" }])),
    },
    connections,
    verdicts: profile.verdicts || [
      { name: "example-bloated-mcp", decision: "rejected", reason: "Prefer lightweight REST or router-owned connector when MCP adds process bloat." },
    ],
  };
}

function syncWorkspaceConfigs(manifest, workspaceRoot, profile = {}) {
  const written = [];
  const vaultPath = manifest.vaultPath;
  const effectiveProfile = {
    userName: manifest.owner,
    routerName: manifest.ideology.routerFunnel,
    boardMode: manifest.board.mode,
    skillsPath: manifest.skillsPath,
    agents: profile.agents || {
      builders: Object.entries(manifest.agents).filter(([, v]) => v.role === "build").map(([k]) => k),
      researchers: Object.entries(manifest.agents).filter(([, v]) => v.role === "research").map(([k]) => k),
    },
    preferences: profile.preferences,
  };

  const agentFiles = [
    ["CLAUDE.md", "claude", "build"],
    ["AGENTS.md", "codex", "build"],
    ["GEMINI.md", "gemini", "research"],
  ];

  for (const [filename, agentName, role] of agentFiles) {
    const filePath = path.join(workspaceRoot, filename);
    fs.writeFileSync(
      filePath,
      renderAgentInstructions({ agentName, role, profile: effectiveProfile, vaultPath }),
      "utf8"
    );
    written.push(filename);
  }

  const mcpServers = {};
  for (const [connName, conn] of Object.entries(manifest.connections || {})) {
    if (conn.type !== "mcp") continue;
    if (conn.secretName && !validateSecretName(conn.secretName)) {
      throw new Error(`Invalid secretName "${conn.secretName}" for connection "${connName}".`);
    }
    mcpServers[connName] = {
      type: "stdio",
      command: conn.command || "npx",
      args: conn.args || ["-y", `@modelcontextprotocol/server-${connName}`],
      env: conn.secretName ? { [conn.secretName]: `\${${conn.secretName}}` } : {},
    };
  }
  const mcpPath = path.join(workspaceRoot, ".mcp.json");
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers }, null, 2) + "\n", "utf8");
  written.push(".mcp.json");

  return { written };
}

async function runInit({
  workspaceRoot = process.cwd(),
  answers = null,
  execProbe,
  homeDir,
  detected = null,
} = {}) {
  const root = path.resolve(workspaceRoot);
  fs.mkdirSync(root, { recursive: true });

  const agents = detected || detectInstalledAgents({ execProbe, homeDir });

  let profile = answers;
  if (!profile) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const model = buildIntroModel(agents, { workspaceRoot: root });
      const selection = await runTerminalIntro({
        ask: q => rl.question(q),
        write: t => process.stdout.write(t),
        detected: agents,
        model,
        onSignIn: runInteractiveSignIn,
      });
      profile = profileFromIntro(selection, agents);
    } finally {
      rl.close();
    }
  }

  const manifest = buildManifestFromProfile(profile, root);
  saveManifest(root, manifest);

  const vaultResult = bootstrapVault(manifest.vaultPath, { ...profile, skillsPath: manifest.skillsPath });

  let boardResult = null;
  let board = null;
  if (manifest.board.mode === "local") {
    board = createLocalBoard({
      boardDir: manifest.board.localDir,
      routerName: manifest.ideology.routerFunnel,
    });
    boardResult = board.initBoard([], { empty: profile.emptyBoard === true });
  }

  const syncResult = syncWorkspaceConfigs(manifest, root, profile);

  return {
    detectedAgents: agents,
    manifest,
    vaultResult,
    boardResult,
    board,
    syncResult,
  };
}

function runDoctor({ workspaceRoot = process.cwd(), execProbe, homeDir, env = process.env, platform = process.platform } = {}) {
  const root = path.resolve(workspaceRoot);
  const manifest = loadManifest(root);
  if (!manifest) {
    return { ok: false, error: NEEDS_SETUP };
  }
  const agents = detectInstalledAgents({ execProbe, homeDir });

  const checks = [];
  checks.push({
    name: "vault_exists",
    ok: fs.existsSync(manifest.vaultPath) && fs.existsSync(path.join(manifest.vaultPath, "08_Systems_and_SOPs", "OPERATING_CONSTITUTION.md")),
    detail: manifest.vaultPath,
  });

  if (manifest.board?.mode === "local") {
    const boardJson = path.join(manifest.board.localDir, "board.json");
    checks.push({
      name: "local_board_ready",
      ok: fs.existsSync(boardJson),
      detail: boardJson,
    });
  } else if (manifest.board?.mode === "sheets") {
    checks.push({
      name: "sheets_board_id_configured",
      ok: Boolean(manifest.board.sheets?.boardId),
      detail: manifest.board.sheets?.boardId || "missing boardId",
    });
  }

  const secretChecks = [];
  for (const [connName, conn] of Object.entries(manifest.connections || {})) {
    if (!conn.secretName) continue;
    const status = checkSecretExists(conn.secretName, { platform, env, execProbe });
    secretChecks.push({ connection: connName, secretName: conn.secretName, ...status });
  }

  const workspaceScan = scanDirectoryForSecrets(root);
  const vaultScan = fs.existsSync(manifest.vaultPath) ? scanDirectoryForSecrets(manifest.vaultPath) : { clean: true, findings: [] };
  const secretHygieneOk = workspaceScan.clean && vaultScan.clean;
  checks.push({
    name: "secret_hygiene_clean",
    ok: secretHygieneOk,
    detail: secretHygieneOk ? "0 leaked secrets or .env files" : `${workspaceScan.findings.length + vaultScan.findings.length} finding(s)`,
    findings: [...workspaceScan.findings, ...vaultScan.findings],
  });

  const ok = checks.every(c => c.ok);
  return {
    ok,
    owner: manifest.owner,
    router: manifest.ideology?.routerFunnel,
    boardMode: manifest.board?.mode,
    agents,
    checks,
    secretChecks,
  };
}

function lanIp() {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

/** Asks in the moment, once, then remembers. Falls back quietly with no terminal. */
async function askOnceInTerminal({ manifest, root, key, question, choices, fallback }) {
  const standing = getSetting(manifest, key);
  if (standing !== undefined) return standing;
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${question}\n\n`);
    choices.forEach((c, i) => process.stdout.write(`  ${i + 1}. ${c.label}\n`));
    const picked = Number((await rl.question("\nPick one [1]: ")).trim() || 1);
    const value = (choices[picked - 1] || choices[0]).value;
    setSetting(manifest, key, value);
    saveManifest(root, manifest);
    return value;
  } finally {
    rl.close();
  }
}

function openBoard(manifest, root) {
  return createLocalBoard({
    boardDir: manifest.board?.localDir || path.join(root, "board"),
    routerName: manifest.ideology?.routerFunnel || "Router",
  });
}

function requireManifest(root) {
  const manifest = loadManifest(root);
  if (!manifest) throw new Error(NEEDS_SETUP);
  return manifest;
}

const printJson = value => process.stdout.write(JSON.stringify(value, null, 2) + "\n");

function makeSaver(root) {
  return next => {
    saveManifest(root, next);
    syncWorkspaceConfigs(next, root);
  };
}

async function setUpPhoneOnThisNetwork(manifest, root) {
  if (!readSecret(SECRET_NAMES.home)) storeSecret(SECRET_NAMES.home, newToken());
  if (!readSecret(SECRET_NAMES.phone)) storeSecret(SECRET_NAMES.phone, newToken());
  manifest.backend = { kind: "local", port: manifest.backend?.port || 8787 };
  saveManifest(root, manifest);
}

async function confirmInTerminal(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} (y/N): `)).trim());
  } finally {
    rl.close();
  }
}

function phoneLinkFor(manifest) {
  const phoneToken = readSecret(SECRET_NAMES.phone);
  if (!phoneToken) return null;
  if (manifest.backend?.kind === "local") {
    const base = `http://${lanIp()}:${manifest.backend.port}`;
    return buildPhoneLink({ pageUrl: `${base}/`, relayUrl: base, phoneToken });
  }
  const pageUrl = loadProductConfig().phoneAppUrl;
  if (!pageUrl || !manifest.backend?.relayUrl) return null;
  return buildPhoneLink({ pageUrl, relayUrl: manifest.backend.relayUrl, phoneToken });
}

const COST_QUESTION = "Creating your phone connection on this Supabase account may add to its bill. Create it anyway?";
const phoneSession = {};

/** One path for the desktop button and the terminal command. Never throws plain errors at a person. */
async function connectPhone({ manifest, root, approveCost = false, confirmCost = null }) {
  const alreadyCloud = manifest.backend && manifest.backend.kind !== "local";
  if (!alreadyCloud) {
    let result;
    try {
      result = await connectBackend({
        product: loadProductConfig(),
        storeSecret,
        session: phoneSession,
        confirmCost: confirmCost || (async () => approveCost),
      });
    } catch (err) {
      return { ok: false, code: err.code || "CONNECT_FAILED", message: err.message };
    }
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message || null, question: result.code === "COST_NOT_APPROVED" ? COST_QUESTION : null };
    }
    manifest.backend = result.backend;
    saveManifest(root, manifest);
    delete phoneSession.accessToken;
  }
  return { ok: true, link: phoneLinkFor(manifest), newlyConnected: !alreadyCloud };
}

async function runWatch(root, manifest) {
  const service = await startHomeServices({
    workspaceRoot: root,
    manifest,
    saveManifest: makeSaver(root),
    onDispatch: res => process.stdout.write(`[AI-first OS] ${res.taskId}: ${res.status}${res.agent ? ` (${labelFor(res.agent)})` : ""}\n`),
    onStatus: text => process.stdout.write(`[AI-first OS] ${text}\n`),
  });
  if (!service.started) {
    process.stdout.write("AI-first OS is already running on this computer.\n");
    return service;
  }
  process.stdout.write(`AI-first OS is watching ${root} (Ctrl+C to stop).\n`);
  const stop = () => {
    service.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return service;
}

const HELP = [
  "AI-first OS",
  "",
  "  aios                   Open the terminal shell (first run sets you up)",
  "  aios desktop           Open the desktop app",
  "  aios task \"<text>\"     Put a task on the board",
  "  aios board             Show the board",
  "  aios run [<id>]        Run the next task, or one by ID",
  "  aios audit <id>        Have the other agent check finished work",
  "  aios ask               Answer anything waiting on you",
  "  aios today             What your agents did today",
  "  aios undo <id> <reopen|withdraw>",
  "  aios role <role> <agent>   Change orchestrator, builder, auditor or researcher",
  "  aios watch             Keep working in the background",
  "  aios autostart on|off  Start with this computer",
  "  aios phone             Get your phone link",
  "  aios phone --here      Use your phone on this Wi-Fi",
  "  aios share \"<text>\" --to <agent>",
  "  aios voice             Say a task",
  "  aios connect [service] Connect a service",
  "  aios doctor            Check everything",
  "",
].join("\n");

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    let answersPath = null;
    let workspaceRoot = process.cwd();
    let targetAgent = null;
    let taskTitle = null;
    let taskId = null;
    let here = false;
    let noWindow = false;
    const positional = [];

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--answers") answersPath = rest[++i];
      else if (rest[i] === "--dir") workspaceRoot = rest[++i];
      else if (rest[i] === "--to" || rest[i] === "--agent") targetAgent = rest[++i];
      else if (rest[i] === "--id") taskId = rest[++i];
      else if (rest[i] === "--here") here = true;
      else if (rest[i] === "--no-window") noWindow = true;
      else if (!rest[i].startsWith("--")) positional.push(rest[i]);
    }
    taskTitle = positional[0] || null;
    const root = path.resolve(workspaceRoot);

    if (cmd === "init") {
      const answers = answersPath ? JSON.parse(fs.readFileSync(path.resolve(answersPath), "utf8")) : null;
      const result = await runInit({ workspaceRoot: root, answers });
      printJson({
        ok: true,
        vaultPath: result.vaultResult.root,
        foldersCreated: result.vaultResult.foldersCreated.length,
        filesWritten: result.vaultResult.filesWritten.length,
        configsSynced: result.syncResult.written,
      });
      return;
    }

    if (cmd === "board") {
      const manifest = requireManifest(root);
      const rows = openBoard(manifest, root).listTasks({ to: targetAgent || undefined });
      printJson({ ok: true, count: rows.length, rows });
      return;
    }

    if (cmd === "task") {
      const manifest = requireManifest(root);
      const added = openBoard(manifest, root).addTask({
        id: taskId || undefined,
        task: taskTitle,
        to: targetAgent || manifest.roles?.builder || "claude",
      });
      printJson({ ok: true, task: added });
      return;
    }

    if (cmd === "run") {
      const manifest = requireManifest(root);
      const board = openBoard(manifest, root);
      const res = await dispatchBoardTask({
        workspaceRoot: root,
        manifest,
        board,
        notices: createNoticeBook({ dir: path.dirname(board.jsonPath) }),
        taskId: taskId || taskTitle || null,
        agent: targetAgent || null,
      });
      printJson({ ok: true, ...res });
      return;
    }

    if (cmd === "audit") {
      const manifest = requireManifest(root);
      const board = openBoard(manifest, root);
      if (!taskTitle) {
        printJson({ ok: true, offers: auditOffers(board) });
        return;
      }
      const res = requestAudit({
        board,
        manifest,
        buildRowId: taskTitle,
        availability: availabilityFromDetected(cachedDetect()),
        notices: createNoticeBook({ dir: path.dirname(board.jsonPath) }),
      });
      printJson({ ok: true, ...res });
      return;
    }

    if (cmd === "ask") {
      const manifest = requireManifest(root);
      const board = openBoard(manifest, root);
      const notices = createNoticeBook({ dir: path.dirname(board.jsonPath) });
      const waiting = notices.listOpen().filter(n => n.choices.length);
      if (!waiting.length) {
        process.stdout.write("Nothing is waiting on you.\n");
        return;
      }
      if (!process.stdin.isTTY) {
        printJson({ ok: true, waiting });
        return;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const notice of waiting) {
          process.stdout.write(`\n${notice.text}\n`);
          notice.choices.forEach((c, i) => process.stdout.write(`  ${i + 1}. ${c.label}\n`));
          const picked = Number((await rl.question("Pick one (Enter to skip): ")).trim());
          if (!picked || !notice.choices[picked - 1]) continue;
          answerNotice({
            noticeId: notice.id,
            value: notice.choices[picked - 1].value,
            digest: notice.digest,
            source: "computer",
            notices,
            board,
            manifest,
            saveManifest: makeSaver(root),
            availability: availabilityFromDetected(cachedDetect()),
          });
        }
      } finally {
        rl.close();
      }
      return;
    }

    if (cmd === "today") {
      const manifest = requireManifest(root);
      const board = openBoard(manifest, root);
      const summary = buildDailySummary({ board, notices: createNoticeBook({ dir: path.dirname(board.jsonPath) }) });
      process.stdout.write(`${summary.headline}\n`);
      for (const f of summary.finished) process.stdout.write(`  ${f.by} finished: ${f.task}\n`);
      for (const w of summary.waiting) process.stdout.write(`  Waiting on you: ${w.text}\n`);
      return;
    }

    if (cmd === "undo") {
      const manifest = requireManifest(root);
      const row = applyUndo({ board: openBoard(manifest, root), row: positional[0], action: positional[1], routerName: manifest.ideology?.routerFunnel });
      printJson({ ok: true, row });
      return;
    }

    if (cmd === "role") {
      const manifest = requireManifest(root);
      const [role, agent] = positional;
      const allowed = [...HARNESSES, ...(role === "orchestrator" ? PERSONAL_AGENTS : [])].map(a => a.id);
      if (!["orchestrator", "builder", "auditor", "researcher"].includes(role) || !allowed.includes(agent)) {
        throw new Error(`Usage: aios role <orchestrator|builder|auditor|researcher> <${allowed.join("|")}>`);
      }
      manifest.roles = { ...manifest.roles, [role]: agent };
      if (role === "orchestrator") manifest.ideology.routerFunnel = labelFor(agent);
      saveManifest(root, manifest);
      printJson({ ok: true, roles: manifest.roles });
      return;
    }

    if (cmd === "watch") {
      await runWatch(root, requireManifest(root));
      return;
    }

    if (cmd === "keep-alive") {
      keepAlive({ cliPath: CLI_PATH, workspaceRoot: root });
      return;
    }

    if (cmd === "autostart") {
      requireManifest(root);
      const options = { cliPath: CLI_PATH, workspaceRoot: root };
      if (positional[0] === "on") printJson(installAutostart(options));
      else if (positional[0] === "off") printJson(removeAutostart(options));
      else printJson({ installed: isAutostartInstalled(options) });
      return;
    }

    if (cmd === "phone") {
      const manifest = requireManifest(root);
      if (here) {
        await setUpPhoneOnThisNetwork(manifest, root);
        process.stdout.write(`\nOpen this on your phone (same Wi-Fi):\n\n${phoneLinkFor(manifest)}\n\n`);
        await runWatch(root, manifest);
        return;
      }
      const result = await connectPhone({ manifest, root, confirmCost: ({ question }) => confirmInTerminal(question) });
      if (!result.ok) {
        process.stdout.write(
          result.code === "OWNER_SETUP_NEEDED"
            ? "Phone access from anywhere is not switched on for this copy yet. For now, `aios phone --here` works on your Wi-Fi.\n"
            : result.code === "COST_NOT_APPROVED"
              ? "Nothing was created, and nothing was charged.\n"
              : `${result.message || "Could not finish setting up your phone."}\n`
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${result.link}\n`);
      return;
    }

    if (cmd === "sync") {
      printJson({ ok: true, ...syncWorkspaceConfigs(requireManifest(root), root) });
      return;
    }

    if (cmd === "doctor") {
      const report = runDoctor({ workspaceRoot: root });
      printJson(report);
      if (!report.ok) process.exitCode = 1;
      return;
    }

    if (cmd === "tui" || !cmd) {
      let manifest = loadManifest(root);
      if (!manifest) manifest = (await runInit({ workspaceRoot: root })).manifest;
      const board = openBoard(manifest, root);
      board.initBoard();
      startTui({
        workspaceRoot: root,
        manifest,
        board,
        notices: createNoticeBook({ dir: path.dirname(board.jsonPath) }),
        onSaveManifest: makeSaver(root),
      });
      return;
    }

    if (cmd === "desktop") {
      const manifest = loadManifest(root);
      const board = manifest ? openBoard(manifest, root) : null;
      if (board) board.initBoard();
      fs.mkdirSync(root, { recursive: true });
      const saver = makeSaver(root);
      let service = null;
      const srv = createDesktopServer({
        workspaceRoot: root,
        manifest,
        board,
        onSaveManifest: saver,
        phone: {
          status: current => ({ connected: Boolean(current.backend && current.backend.kind !== "local"), link: current.backend && current.backend.kind !== "local" ? phoneLinkFor(current) : null }),
          async connect(current, { approveCost }) {
            const result = await connectPhone({ manifest: current, root, approveCost });
            if (result.ok && result.newlyConnected) {
              service?.stop();
              service = await startHomeServices({ workspaceRoot: root, manifest: current, saveManifest: saver });
            }
            return result;
          },
        },
        async onIntroComplete({ selection, detected }) {
          const made = await runInit({ workspaceRoot: root, answers: profileFromIntro(selection, detected), detected });
          service = await startHomeServices({ workspaceRoot: root, manifest: made.manifest, saveManifest: saver });
          return made;
        },
      });
      await new Promise(r => srv.listen(0, "127.0.0.1", r));
      if (manifest) service = await startHomeServices({ workspaceRoot: root, manifest, saveManifest: saver });
      const url = `http://127.0.0.1:${srv.address().port}`;
      process.stdout.write(`AI-first OS is open at ${url}\n`);
      if (!noWindow) launchFramelessAppWindow(url);
      process.on("SIGINT", () => {
        service?.stop();
        process.exit(0);
      });
      return;
    }

    if (cmd === "connect") {
      const manifest = requireManifest(root);
      if (!taskTitle) {
        printJson({ ok: true, availableServices: SERVICE_DROPDOWN_CATALOG });
        return;
      }
      const updated = connectServiceFromCatalog(manifest, taskTitle);
      makeSaver(root)(updated.manifest);
      printJson({ ok: true, connected: updated.connected });
      return;
    }

    if (cmd === "share") {
      const manifest = requireManifest(root);
      const fallback = manifest.roles?.builder || "claude";
      const target =
        targetAgent ||
        (await askOnceInTerminal({
          manifest,
          root,
          key: "settings.shareTo",
          question: "Who do you want to share with?",
          choices: HARNESSES.map(h => ({ label: h.label, value: h.id })),
          fallback,
        }));
      printJson(
        shareToTarget({
          target,
          content: taskTitle,
          workspaceRoot: root,
          vaultPath: manifest.vaultPath,
          board: openBoard(manifest, root),
          routerName: manifest.ideology?.routerFunnel || "Router",
        })
      );
      return;
    }

    if (cmd === "voice") {
      const manifest = requireManifest(root);
      const cap = captureVoiceNative({ timeoutSeconds: 8, mockTranscript: taskTitle || null });
      if (!cap.ok || !cap.transcript) {
        throw new Error(cap.error || "No speech detected.");
      }
      const saved = saveVoiceDumpToInbox({
        vaultPath: manifest.vaultPath,
        transcript: cap.transcript,
        routerName: manifest.ideology?.routerFunnel || "Router",
        board: openBoard(manifest, root),
        autoQueueTo: targetAgent || manifest.roles?.builder || "claude",
      });
      printJson({ ok: true, transcript: cap.transcript, ...saved });
      return;
    }

    process.stdout.write(HELP);
  })().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  toSimpleYaml,
  buildManifestFromProfile,
  loadManifest,
  syncWorkspaceConfigs,
  runInit,
  runDoctor,
};
