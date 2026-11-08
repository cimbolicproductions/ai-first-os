#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { detectInstalledAgents, runInteractiveSignIn, structureNeedsWithSignedInAgent } = require("../lib/agent-auth.cjs");
const { bootstrapVault } = require("../lib/vault-bootstrap.cjs");
const { renderAgentInstructions } = require("../lib/ideology.cjs");
const { validateSecretName, checkSecretExists, scanDirectoryForSecrets } = require("../lib/keyring.cjs");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { dispatchBoardTask, watchTaskBoard } = require("../lib/os-runtime.cjs");
const { startOmarchyTui } = require("../lib/omarchy-tui.cjs");
const { createOmarchyDesktopServer, launchFramelessAppWindow } = require("../lib/omarchy-desktop.cjs");
const { connectServiceFromCatalog, SERVICE_DROPDOWN_CATALOG } = require("../lib/service-catalog.cjs");
const { captureVoiceNative, saveVoiceDumpToInbox, shareToTarget } = require("../lib/voice-and-share.cjs");

function toSimpleYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean" || typeof obj === "number") return String(obj);
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    if (!obj.length) return "[]";
    return "\n" + obj.map(item => {
      if (item && typeof item === "object") {
        const inner = toSimpleYaml(item, indent + 2).trimStart();
        return `${pad}  - ${inner}`;
      }
      return `${pad}  - ${toSimpleYaml(item, 0)}`;
    }).join("\n");
  }
  const entries = Object.entries(obj);
  if (!entries.length) return "{}";
  return entries.map(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      return `${pad}${k}:\n${toSimpleYaml(v, indent + 1)}`;
    }
    if (Array.isArray(v) && v.length > 0) {
      return `${pad}${k}:${toSimpleYaml(v, indent)}`;
    }
    return `${pad}${k}: ${toSimpleYaml(v, 0)}`;
  }).join("\n");
}

async function runProgressiveInterview(ask, detectedAgents) {
  const signedIn = detectedAgents.filter(a => a.signedIn);
  const userName = (await ask("1. What is your name or handle? [User]: ")).trim() || "User";
  const primaryGoal = (await ask("2. What is the #1 focus you want your AI-first OS to help you execute right now?: ")).trim()
    || "Ship high-leverage work with connected AI services and a shared task board.";
  const rolesRaw = (await ask("3. How would you describe your roles? (comma-separated, e.g., Developer, Researcher, Creator) [Builder]: ")).trim() || "Builder";
  const roles = rolesRaw.split(",").map(s => s.trim()).filter(Boolean);

  const projectsRaw = (await ask("4. What active projects or workflows are you working on right now? (comma-separated): ")).trim();
  const projects = structureNeedsWithSignedInAgent(projectsRaw, signedIn[0]);

  const hasResAns = (await ask("5. Do you want a Research & Transcripts workspace module (notes, articles, transcripts)? (y/N): ")).trim().toLowerCase();
  const hasResearch = hasResAns === "y" || hasResAns === "yes";

  const hasOpsAns = (await ask("6. Do you want an Operations & Feedback workspace module (services, users, feedback logs)? (y/N): ")).trim().toLowerCase();
  const hasBusinesses = hasOpsAns === "y" || hasOpsAns === "yes";

  const hasCareerAns = (await ask("7. Do you want a Career & Portfolio workspace module? (y/N): ")).trim().toLowerCase();
  const hasCareer = hasCareerAns === "y" || hasCareerAns === "yes";

  const workStyleAns = (await ask("8. How do you run your OS? (1 = Single computer, 2 = Desktop + Phone/Mobile + Always-On Hub) [1]: ")).trim() || "1";
  const workStyle = workStyleAns === "2" ? "hybrid-hub-and-mobile" : "single-machine";

  let hubOs = null;
  if (workStyle === "hybrid-hub-and-mobile") {
    hubOs = (await ask("   -> What OS runs your always-on hub? (macos / linux / windows) [macos]: ")).trim().toLowerCase() || "macos";
  }

  const routerName = (await ask("9. What do you want to call your central Organizer / Router agent? [Router]: ")).trim() || "Router";

  const defaultBuilders = detectedAgents.filter(a => a.defaultRole === "build" && a.installed).map(a => a.id);
  const buildersRaw = (await ask(`10. Which connected AI services should execute BUILD tasks on the board? (comma-separated) [${(defaultBuilders.length ? defaultBuilders : ["claude", "codex"]).join(",")}]: `)).trim();
  const builders = buildersRaw ? buildersRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : (defaultBuilders.length ? defaultBuilders : ["claude", "codex"]);

  const researchersRaw = (await ask("11. Which connected AI service should execute read-only RESEARCH tasks? [gemini]: ")).trim();
  const researchers = researchersRaw ? researchersRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : ["gemini"];

  const boardAns = (await ask("12. Task Board backend: (1 = Local instant JSON/Markdown Task Board, 2 = Cloud Google Sheet + Realtime WebSocket Doorbell) [1]: ")).trim() || "1";
  const boardMode = boardAns === "2" ? "sheets" : "local";

  let sheetsConfig = null;
  if (boardMode === "sheets") {
    const boardId = (await ask("   -> Google Sheet ID for your Task Board: ")).trim();
    const saKeyEnv = (await ask("   -> Secret name for Google Service Account JSON path [GOOGLE_BOARD_SA_PATH]: ")).trim() || "GOOGLE_BOARD_SA_PATH";
    const realtimeUrlEnv = (await ask("   -> Secret/env name for Supabase URL [SUPABASE_URL]: ")).trim() || "SUPABASE_URL";
    const realtimeKeyEnv = (await ask("   -> Secret/env name for Supabase Publishable Key [SUPABASE_PUBLISHABLE_KEY]: ")).trim() || "SUPABASE_PUBLISHABLE_KEY";
    sheetsConfig = { boardId, saKeyEnv, realtimeUrlEnv, realtimeKeyEnv };
  }

  const extraServicesRaw = (await ask("13. Extra services to wire into your OS (comma-separated, e.g., github, web-search, database) [github]: ")).trim() || "github";
  const extraServices = extraServicesRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const connections = {};
  for (const svc of extraServices) {
    const envVar = `${svc.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_TOKEN`;
    connections[svc] = {
      type: "mcp",
      agents: [...builders, ...researchers],
      secretName: svc === "github" ? "GITHUB_TOKEN" : envVar,
    };
  }

  const vaultPathAns = (await ask("14. Where should your OS Context Vault folder be created? [./ContextVault]: ")).trim() || "./ContextVault";

  return {
    userName,
    primaryGoal,
    roles,
    hasBusinesses,
    hasResearch,
    hasCareer,
    projects,
    workStyle,
    hubOs,
    routerName,
    agents: {
      router: routerName,
      builders,
      researchers,
    },
    boardMode,
    sheetsConfig,
    connections,
    vaultPath: vaultPathAns,
  };
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

  const connections = {
    github: {
      type: "mcp",
      agents: [...(profile.agents?.builders || ["claude", "codex"]), ...(profile.agents?.researchers || ["gemini"])],
      secretName: "GITHUB_TOKEN",
    },
    ...(profile.connections || {}),
  };

  return {
    name: "ai-first-os",
    version: 1,
    owner: profile.userName || "User",
    primaryGoal: profile.primaryGoal || "Ship high-leverage work",
    vaultPath: path.resolve(workspaceRoot, profile.vaultPath || "./ContextVault"),
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
    agents: {
      [String(profile.routerName || "router").toLowerCase()]: { role: "organize", managedBy: "router" },
      ...Object.fromEntries((profile.agents?.builders || ["claude", "codex"]).map(a => [a, { role: "build" }])),
      ...Object.fromEntries((profile.agents?.researchers || ["gemini"]).map(a => [a, { role: "research" }])),
    },
    connections,
    verdicts: profile.verdicts || [
      { name: "example-bloated-mcp", decision: "rejected", reason: "Prefer lightweight REST or router-owned connector when MCP adds process bloat." },
    ],
  };
}

function loadManifest(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  for (const candidate of ["aios.json", "fleet.json"]) {
    const p = path.join(root, candidate);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

function syncWorkspaceConfigs(manifest, workspaceRoot, profile = {}) {
  const written = [];
  const vaultPath = manifest.vaultPath;
  const effectiveProfile = {
    userName: manifest.owner,
    routerName: manifest.ideology.routerFunnel,
    boardMode: manifest.board.mode,
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
  promptSignIn = false,
} = {}) {
  const root = path.resolve(workspaceRoot);
  fs.mkdirSync(root, { recursive: true });

  // Phase 1: Detect AI accounts & sign-in status
  const detected = detectInstalledAgents({ execProbe, homeDir });

  let profile = answers;
  if (!profile) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => rl.question(q);
    try {
      process.stdout.write("\n=== Phase 1: AI Service Discovery & Sign-In ===\n");
      for (const a of detected) {
        process.stdout.write(
          `  - ${a.label}: ${a.installed ? (a.signedIn ? "CONNECTED & SIGNED IN" : "INSTALLED (not signed in)") : "not found"}\n`
        );
        if (promptSignIn && a.installed && !a.signedIn) {
          const ans = (await ask(`    Sign in to ${a.label} now? (y/N): `)).trim().toLowerCase();
          if (ans === "y" || ans === "yes") runInteractiveSignIn(a);
        }
      }
      process.stdout.write("\n=== Phase 2: AI-first OS Setup Interview ===\n");
      profile = await runProgressiveInterview(ask, detected);
    } finally {
      rl.close();
    }
  }

  // Phase 3: Write manifest (aios.json/yaml + fleet.json/yaml alias), bootstrap Vault, initialize Task Board, sync agent configs
  const manifest = buildManifestFromProfile(profile, root);
  const yamlText = `# Generated by AI-first OS init - stores secret NAMES only, never secret values\n${toSimpleYaml(manifest)}\n`;
  for (const jsonName of ["aios.json", "fleet.json"]) {
    fs.writeFileSync(path.join(root, jsonName), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  for (const yamlName of ["aios.yaml", "fleet.yaml"]) {
    fs.writeFileSync(path.join(root, yamlName), yamlText, "utf8");
  }

  const vaultResult = bootstrapVault(manifest.vaultPath, profile);

  let boardResult = null;
  if (manifest.board.mode === "local") {
    const localBoard = createLocalBoard({
      boardDir: manifest.board.localDir,
      routerName: manifest.ideology.routerFunnel,
    });
    boardResult = localBoard.initBoard();
  }

  const syncResult = syncWorkspaceConfigs(manifest, root, profile);

  return {
    detectedAgents: detected,
    manifest,
    vaultResult,
    boardResult,
    syncResult,
  };
}

function runDoctor({ workspaceRoot = process.cwd(), execProbe, homeDir, env = process.env, platform = process.platform } = {}) {
  const root = path.resolve(workspaceRoot);
  const manifest = loadManifest(root);
  if (!manifest) {
    return { ok: false, error: "aios.json not found. Run `node bin/aios.cjs init` first." };
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

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    let answersPath = null;
    let workspaceRoot = process.cwd();
    let targetAgent = null;
    let taskTitle = null;
    let taskId = null;

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--answers") answersPath = rest[++i];
      else if (rest[i] === "--dir") workspaceRoot = rest[++i];
      else if (rest[i] === "--to" || rest[i] === "--agent") targetAgent = rest[++i];
      else if (rest[i] === "--id") taskId = rest[++i];
      else if (!rest[i].startsWith("--") && !taskTitle) taskTitle = rest[i];
    }

    if (cmd === "init") {
      const answers = answersPath ? JSON.parse(fs.readFileSync(path.resolve(answersPath), "utf8")) : null;
      const result = await runInit({ workspaceRoot, answers, promptSignIn: !answers });
      process.stdout.write(JSON.stringify({
        ok: true,
        vaultPath: result.vaultResult.root,
        foldersCreated: result.vaultResult.foldersCreated.length,
        filesWritten: result.vaultResult.filesWritten.length,
        configsSynced: result.syncResult.written,
      }, null, 2) + "\n");
      return;
    }

    if (cmd === "board") {
      const manifest = loadManifest(workspaceRoot);
      if (!manifest) throw new Error("aios.json not found. Run `node bin/aios.cjs init` first.");
      const board = createLocalBoard({
        boardDir: manifest.board.localDir || path.join(path.resolve(workspaceRoot), "board"),
        routerName: manifest.ideology.routerFunnel,
      });
      const rows = board.listTasks({ to: targetAgent || undefined });
      process.stdout.write(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2) + "\n");
      return;
    }

    if (cmd === "task") {
      const manifest = loadManifest(workspaceRoot);
      if (!manifest) throw new Error("aios.json not found. Run `node bin/aios.cjs init` first.");
      const board = createLocalBoard({
        boardDir: manifest.board.localDir || path.join(path.resolve(workspaceRoot), "board"),
        routerName: manifest.ideology.routerFunnel,
      });
      const added = board.addTask({
        id: taskId || undefined,
        task: taskTitle,
        to: targetAgent || "claude",
      });
      process.stdout.write(JSON.stringify({ ok: true, task: added }, null, 2) + "\n");
      return;
    }

    if (cmd === "run") {
      const manifest = loadManifest(workspaceRoot);
      if (!manifest) throw new Error("aios.json not found. Run `node bin/aios.cjs init` first.");
      const res = await dispatchBoardTask({
        workspaceRoot: path.resolve(workspaceRoot),
        manifest,
        taskId: taskId || taskTitle || null,
        agent: targetAgent || null,
      });
      process.stdout.write(JSON.stringify({ ok: true, ...res }, null, 2) + "\n");
      return;
    }

    if (cmd === "watch") {
      const manifest = loadManifest(workspaceRoot);
      if (!manifest) throw new Error("aios.json not found. Run `node bin/aios.cjs init` first.");
      process.stdout.write(`Watching AI-first OS Task Board in ${path.resolve(workspaceRoot)} (Ctrl+C to stop)...\n`);
      watchTaskBoard({
        workspaceRoot: path.resolve(workspaceRoot),
        manifest,
        agent: targetAgent || null,
        onDispatch(res) {
          process.stdout.write(`[AI-first OS] Dispatched ${res.taskId} -> ${res.agent}: ${res.status} (handed to ${res.handedTo})\n`);
        },
      });
      return;
    }

    if (cmd === "sync") {
      const manifest = loadManifest(workspaceRoot);
      if (!manifest) throw new Error("aios.json not found. Run `node bin/aios.cjs init` first.");
      const res = syncWorkspaceConfigs(manifest, path.resolve(workspaceRoot));
      process.stdout.write(JSON.stringify({ ok: true, ...res }, null, 2) + "\n");
      return;
    }

    if (cmd === "doctor") {
      const report = runDoctor({ workspaceRoot });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (!report.ok) process.exitCode = 1;
      return;
    }

    if (cmd === "tui" || !cmd) {
      let manifest = loadManifest(workspaceRoot);
      if (!manifest) {
        const initRes = await runInit({ workspaceRoot, promptSignIn: true });
        manifest = initRes.manifest;
      }
      const root = path.resolve(workspaceRoot);
      const board = createLocalBoard({
        boardDir: manifest.board?.localDir || path.join(root, "board"),
        routerName: manifest.ideology?.routerFunnel || "Router",
      });
      board.initBoard();
      startOmarchyTui({
        workspaceRoot: root,
        manifest,
        board,
        onSaveManifest(nextManifest) {
          fs.writeFileSync(path.join(root, "aios.json"), JSON.stringify(nextManifest, null, 2) + "\n", "utf8");
          fs.writeFileSync(path.join(root, "aios.yaml"), `# Generated by AI-first OS\n${toSimpleYaml(nextManifest)}\n`, "utf8");
          syncWorkspaceConfigs(nextManifest, root);
        },
      });
      return;
    }

    if (cmd === "desktop") {
      let manifest = loadManifest(workspaceRoot);
      if (!manifest) {
        const initRes = await runInit({ workspaceRoot, promptSignIn: true });
        manifest = initRes.manifest;
      }
      const root = path.resolve(workspaceRoot);
      const board = createLocalBoard({
        boardDir: manifest.board?.localDir || path.join(root, "board"),
        routerName: manifest.ideology?.routerFunnel || "Router",
      });
      board.initBoard();
      const srv = createOmarchyDesktopServer({
        workspaceRoot: root,
        manifest,
        board,
        onSaveManifest(nextManifest) {
          fs.writeFileSync(path.join(root, "aios.json"), JSON.stringify(nextManifest, null, 2) + "\n", "utf8");
          fs.writeFileSync(path.join(root, "aios.yaml"), `# Generated by AI-first OS\n${toSimpleYaml(nextManifest)}\n`, "utf8");
          syncWorkspaceConfigs(nextManifest, root);
        },
      });
      await new Promise(r => srv.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${srv.address().port}`;
      process.stdout.write(`AI-first OS Omarchy Desktop running at ${url}\n`);
      launchFramelessAppWindow(url);
      return;
    }

    if (cmd === "connect") {
      const manifest = loadManifest(workspaceRoot);
      if (!manifest) throw new Error("aios.json not found. Run `node bin/aios.cjs init` first.");
      if (!taskTitle) {
        process.stdout.write(JSON.stringify({ ok: true, availableServices: SERVICE_DROPDOWN_CATALOG }, null, 2) + "\n");
        return;
      }
      const root = path.resolve(workspaceRoot);
      const updated = connectServiceFromCatalog(manifest, taskTitle);
      fs.writeFileSync(path.join(root, "aios.json"), JSON.stringify(updated.manifest, null, 2) + "\n", "utf8");
      fs.writeFileSync(path.join(root, "aios.yaml"), `# Generated by AI-first OS\n${toSimpleYaml(updated.manifest)}\n`, "utf8");
      syncWorkspaceConfigs(updated.manifest, root);
      process.stdout.write(JSON.stringify({ ok: true, connected: updated.connected }, null, 2) + "\n");
      return;
    }

    if (cmd === "share") {
      const manifest = loadManifest(workspaceRoot);
      if (!manifest) throw new Error("aios.json not found. Run `node bin/aios.cjs init` first.");
      const root = path.resolve(workspaceRoot);
      const board = createLocalBoard({
        boardDir: manifest.board?.localDir || path.join(root, "board"),
        routerName: manifest.ideology?.routerFunnel || "Router",
      });
      const res = shareToTarget({
        target: targetAgent || "agy",
        content: taskTitle,
        workspaceRoot: root,
        vaultPath: manifest.vaultPath,
        board,
        routerName: manifest.ideology?.routerFunnel || "Router",
      });
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      return;
    }

    if (cmd === "voice") {
      const manifest = loadManifest(workspaceRoot);
      if (!manifest) throw new Error("aios.json not found. Run `node bin/aios.cjs init` first.");
      const root = path.resolve(workspaceRoot);
      const board = createLocalBoard({
        boardDir: manifest.board?.localDir || path.join(root, "board"),
        routerName: manifest.ideology?.routerFunnel || "Router",
      });
      const cap = captureVoiceNative({ timeoutSeconds: 8, mockTranscript: taskTitle || null });
      if (!cap.ok || !cap.transcript) {
        throw new Error(cap.error || "No speech detected.");
      }
      const saved = saveVoiceDumpToInbox({
        vaultPath: manifest.vaultPath,
        transcript: cap.transcript,
        routerName: manifest.ideology?.routerFunnel || "Router",
        board,
        autoQueueTo: targetAgent || "claude",
      });
      process.stdout.write(JSON.stringify({ ok: true, transcript: cap.transcript, ...saved }, null, 2) + "\n");
      return;
    }

    process.stdout.write(
      [
        "AI-first OS (Omarchy-Style Keyboard-First AI Operating System)",
        "Usage:",
        "  node bin/aios.cjs                   Launch full-screen Omarchy TUI shell (runs init first if needed)",
        "  node bin/aios.cjs desktop           Launch frameless Omarchy Desktop HUD window + global hotkeys",
        "  node bin/aios.cjs init              Detect/sign in to AI accounts & run progressive setup interview",
        "  node bin/aios.cjs connect [service] Connect a service from the plug-and-play dropdown catalog",
        "  node bin/aios.cjs share [text] --to <agy|claude|codex|gemini|board>  1-step share to any AI tool",
        "  node bin/aios.cjs voice             Capture native voice-to-text straight into Vault + Task Board",
        "  node bin/aios.cjs board             List Task Board rows",
        "  node bin/aios.cjs task \"<title>\" --to <agent>  Queue a task onto the Task Board",
        "  node bin/aios.cjs run [<taskId>]    Claim and execute a Task Board row",
        "  node bin/aios.cjs watch             Watch Task Board in real time and wake assigned AI services",
        "  node bin/aios.cjs sync              Regenerate CLAUDE.md, AGENTS.md, GEMINI.md, and .mcp.json",
        "  node bin/aios.cjs doctor            Verify AI sign-ins, board state, keyring names, and secret hygiene",
        "",
      ].join("\n")
    );
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
