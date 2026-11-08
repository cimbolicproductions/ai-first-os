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
  const userName = (await ask("1. What is your first name (or handle)? [Operator]: ")).trim() || "Operator";
  const primaryGoal = (await ask("2. What is your #1 priority over the next 90 days? (e.g., land a tech role, grow SaaS revenue): ")).trim()
    || "Ship high-leverage work with minimal coordination overhead.";
  const rolesRaw = (await ask("3. What roles do you play? (comma-separated, e.g., Founder, Engineer, Parent) [Builder]: ")).trim() || "Builder";
  const roles = rolesRaw.split(",").map(s => s.trim()).filter(Boolean);

  // Progressive branching based on what they actually need
  const hasBizAns = (await ask("4. Do you run businesses or client services that need Offers/Customers/Raw-Feedback folders? (y/N): ")).trim().toLowerCase();
  const hasBusinesses = hasBizAns === "y" || hasBizAns === "yes";

  const hasResAns = (await ask("5. Do you process podcasts, transcripts, books, or deep research notes? (y/N): ")).trim().toLowerCase();
  const hasResearch = hasResAns === "y" || hasResAns === "yes";

  const hasCareerAns = (await ask("6. Are you actively running a job-hunt or career pipeline? (y/N): ")).trim().toLowerCase();
  const hasCareer = hasCareerAns === "y" || hasCareerAns === "yes";

  const projectsRaw = (await ask("7. Name your top 1-3 active projects right now (comma-separated): ")).trim();
  const projects = structureNeedsWithSignedInAgent(projectsRaw, signedIn[0]);

  const workStyleAns = (await ask("8. How do you work? (1 = Single computer at desk, 2 = Mobile/Phone + Desktop + Always-On Hub) [2]: ")).trim() || "2";
  const workStyle = workStyleAns === "1" ? "single-machine" : "hybrid-hub-and-mobile";

  let hubOs = null;
  if (workStyle === "hybrid-hub-and-mobile") {
    hubOs = (await ask("   -> What OS runs your always-on hub? (macos / linux / windows) [macos]: ")).trim().toLowerCase() || "macos";
  }

  const routerName = (await ask("9. What do you call your Router / Organizer agent? (e.g., Juno, Atlas, Router) [Juno]: ")).trim() || "Juno";

  const defaultBuilders = detectedAgents.filter(a => a.defaultRole === "build" && a.installed).map(a => a.id);
  const buildersRaw = (await ask(`10. Which agents should own BUILD rows? (comma-separated) [${(defaultBuilders.length ? defaultBuilders : ["claude", "codex"]).join(",")}]: `)).trim();
  const builders = buildersRaw ? buildersRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : (defaultBuilders.length ? defaultBuilders : ["claude", "codex"]);

  const researchersRaw = (await ask("11. Which agent should own read-only RESEARCH rows? [gemini]: ")).trim();
  const researchers = researchersRaw ? researchersRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : ["gemini"];

  const boardAns = (await ask("12. Shared Board mode: (1 = Local instant JSON/Markdown board, 2 = Google Sheets + Supabase Realtime Doorbell) [1]: ")).trim() || "1";
  const boardMode = boardAns === "2" ? "sheets" : "local";

  let sheetsConfig = null;
  if (boardMode === "sheets") {
    const boardId = (await ask("   -> Google Sheet ID for Agent Tasks: ")).trim();
    const saKeyEnv = (await ask("   -> Secret name for Google Service Account JSON path [GOOGLE_BOARD_SA_PATH]: ")).trim() || "GOOGLE_BOARD_SA_PATH";
    const realtimeUrlEnv = (await ask("   -> Secret/env name for Supabase URL [SUPABASE_URL]: ")).trim() || "SUPABASE_URL";
    const realtimeKeyEnv = (await ask("   -> Secret/env name for Supabase Publishable Key [SUPABASE_PUBLISHABLE_KEY]: ")).trim() || "SUPABASE_PUBLISHABLE_KEY";
    sheetsConfig = { boardId, saKeyEnv, realtimeUrlEnv, realtimeKeyEnv };
  }

  const vaultPathAns = (await ask("13. Where should your Context Vault folder be created? [./ContextVault]: ")).trim() || "./ContextVault";

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
    version: 1,
    owner: profile.userName || "Operator",
    primaryGoal: profile.primaryGoal || "Ship high-leverage work",
    vaultPath: path.resolve(workspaceRoot, profile.vaultPath || "./ContextVault"),
    board: {
      mode: profile.boardMode || "local",
      canonicalAuthority: profile.boardMode === "sheets" ? "google-sheet" : "local-json",
      writeRule: "by-column-name-never-position",
      ...(profile.sheetsConfig ? { sheets: profile.sheetsConfig } : { localDir: path.resolve(workspaceRoot, "./board") }),
    },
    ideology: {
      routerFunnel: profile.routerName || "Juno",
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
      [String(profile.routerName || "juno").toLowerCase()]: { role: "organize", managedBy: "router" },
      ...Object.fromEntries((profile.agents?.builders || ["claude", "codex"]).map(a => [a, { role: "build" }])),
      ...Object.fromEntries((profile.agents?.researchers || ["gemini"]).map(a => [a, { role: "research" }])),
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
    agents: profile.agents || {
      builders: Object.entries(manifest.agents).filter(([, v]) => v.role === "build").map(([k]) => k),
      researchers: Object.entries(manifest.agents).filter(([, v]) => v.role === "research").map(([k]) => k),
    },
    preferences: profile.preferences,
  };

  // Write root CLAUDE.md, AGENTS.md, GEMINI.md so every CLI starts with the exact same constitution
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

  // Write .mcp.json referencing secret NAMES only (${SECRET_NAME}), never secret values
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
      process.stdout.write("\n=== Phase 1: AI Account Discovery ===\n");
      for (const a of detected) {
        process.stdout.write(
          `  - ${a.label}: ${a.installed ? (a.signedIn ? "INSTALLED & SIGNED IN" : "INSTALLED (not signed in)") : "not found"}\n`
        );
        if (promptSignIn && a.installed && !a.signedIn) {
          const ans = (await ask(`    Sign in to ${a.label} now? (y/N): `)).trim().toLowerCase();
          if (ans === "y" || ans === "yes") runInteractiveSignIn(a);
        }
      }
      process.stdout.write("\n=== Phase 2: Progressive Operating System Interview ===\n");
      profile = await runProgressiveInterview(ask, detected);
    } finally {
      rl.close();
    }
  }

  // Phase 3: Build manifest, bootstrap tailored Context Vault, initialize Board, sync agent configs
  const manifest = buildManifestFromProfile(profile, root);
  const manifestJsonPath = path.join(root, "fleet.json");
  const manifestYamlPath = path.join(root, "fleet.yaml");
  fs.writeFileSync(manifestJsonPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(manifestYamlPath, `# Generated by fleet init — secret NAMES only, never secret values\n${toSimpleYaml(manifest)}\n`, "utf8");

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
  const manifestJsonPath = path.join(root, "fleet.json");
  if (!fs.existsSync(manifestJsonPath)) {
    return { ok: false, error: "fleet.json not found. Run `node bin/fleet.cjs init` first." };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestJsonPath, "utf8"));
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

  // Verify secret names resolve without printing values
  const secretChecks = [];
  for (const [connName, conn] of Object.entries(manifest.connections || {})) {
    if (!conn.secretName) continue;
    const status = checkSecretExists(conn.secretName, { platform, env, execProbe });
    secretChecks.push({ connection: connName, secretName: conn.secretName, ...status });
  }

  // Secret leak scan across both workspace and vault
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
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--answers") answersPath = rest[++i];
      else if (rest[i] === "--dir") workspaceRoot = rest[++i];
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
    if (cmd === "sync") {
      const manifest = JSON.parse(fs.readFileSync(path.join(path.resolve(workspaceRoot), "fleet.json"), "utf8"));
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
    process.stdout.write("Usage: node bin/fleet.cjs <init|sync|doctor> [--dir <path>] [--answers <json>]\n");
  })().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  toSimpleYaml,
  buildManifestFromProfile,
  syncWorkspaceConfigs,
  runInit,
  runDoctor,
};
