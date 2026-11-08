"use strict";

/**
 * Plug-and-play Service Catalog & Omarchy Theme Definitions for AI-first OS.
 * Allows selecting any AI service or external tool from a dropdown, prompting
 * only for missing initialization fields, storing secrets in the OS keyring,
 * and wiring it straight into the Task Board and agent sessions.
 */

const OMARCHY_THEMES = Object.freeze({
  "tokyo-night": {
    name: "Tokyo Night",
    bg: "#1a1b26",
    panel: "#24283b",
    border: "#414868",
    text: "#c0caf5",
    muted: "#565f89",
    accent: "#7aa2f7",
    green: "#9ece6a",
    yellow: "#e0af68",
    red: "#f7768e",
    ansiAccent: "\x1b[38;2;122;162;247m",
    ansiGreen: "\x1b[38;2;158;206;106m",
    ansiYellow: "\x1b[38;2;224;175;104m",
    ansiRed: "\x1b[38;2;247;118;142m",
    ansiMuted: "\x1b[38;2;86;95;137m",
  },
  catppuccin: {
    name: "Catppuccin Mocha",
    bg: "#1e1e2e",
    panel: "#181825",
    border: "#45475a",
    text: "#cdd6f4",
    muted: "#6c7086",
    accent: "#cba6f7",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    red: "#f38ba8",
    ansiAccent: "\x1b[38;2;203;166;247m",
    ansiGreen: "\x1b[38;2;166;227;161m",
    ansiYellow: "\x1b[38;2;249;226;175m",
    ansiRed: "\x1b[38;2;243;139;168m",
    ansiMuted: "\x1b[38;2;108;112;134m",
  },
  gruvbox: {
    name: "Gruvbox Dark",
    bg: "#282828",
    panel: "#1d2021",
    border: "#504945",
    text: "#ebdbb2",
    muted: "#928374",
    accent: "#fe8019",
    green: "#b8bb26",
    yellow: "#fabd2f",
    red: "#fb4934",
    ansiAccent: "\x1b[38;2;254;128;25m",
    ansiGreen: "\x1b[38;2;184;187;38m",
    ansiYellow: "\x1b[38;2;250;189;47m",
    ansiRed: "\x1b[38;2;251;73;52m",
    ansiMuted: "\x1b[38;2;146;131;116m",
  },
  kanagawa: {
    name: "Kanagawa Wave",
    bg: "#1f1f28",
    panel: "#16161d",
    border: "#363646",
    text: "#dcd7ba",
    muted: "#727169",
    accent: "#7e9cd8",
    green: "#98bb6c",
    yellow: "#e6c384",
    red: "#e46876",
    ansiAccent: "\x1b[38;2;126;156;216m",
    ansiGreen: "\x1b[38;2;152;187;108m",
    ansiYellow: "\x1b[38;2;230;195;132m",
    ansiRed: "\x1b[38;2;228;104;118m",
    ansiMuted: "\x1b[38;2;114;113;105m",
  },
  everforest: {
    name: "Everforest Dark",
    bg: "#2d353b",
    panel: "#232a2e",
    border: "#475258",
    text: "#d3c6aa",
    muted: "#859289",
    accent: "#a7c080",
    green: "#a7c080",
    yellow: "#dbbc7f",
    red: "#e67e80",
    ansiAccent: "\x1b[38;2;167;192;128m",
    ansiGreen: "\x1b[38;2;167;192;128m",
    ansiYellow: "\x1b[38;2;219;188;127m",
    ansiRed: "\x1b[38;2;230;126;128m",
    ansiMuted: "\x1b[38;2;133;146;137m",
  },
});

const SERVICE_DROPDOWN_CATALOG = Object.freeze([
  {
    id: "claude",
    category: "ai-agent",
    label: "Claude Code (Builder)",
    role: "build",
    Hotkey: "2",
    initCommand: "claude auth login",
    description: "Autonomous code builder in isolated git branches/worktrees.",
  },
  {
    id: "codex",
    category: "ai-agent",
    label: "OpenAI Codex CLI (Builder)",
    role: "build",
    Hotkey: "3",
    initCommand: "codex login",
    description: "Autonomous code builder and test runner.",
  },
  {
    id: "gemini",
    category: "ai-agent",
    label: "Gemini CLI (Researcher)",
    role: "research",
    Hotkey: "4",
    initCommand: "gemini",
    description: "Read-only deep research, synthesis, and verification lane.",
  },
  {
    id: "agy",
    category: "ai-agent",
    label: "Antigravity IDE / CLI",
    role: "build",
    Hotkey: "5",
    initCommand: "agy",
    description: "Instant handoff and pair-programming session target.",
  },
  {
    id: "github",
    category: "connector",
    label: "GitHub (MCP)",
    connectionType: "mcp",
    secretName: "GITHUB_TOKEN",
    promptLabel: "Enter your GitHub Personal Access Token (saved to OS Keyring as GITHUB_TOKEN)",
    agents: ["claude", "codex", "gemini"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    description: "Repo PRs, issues, and branch workflows.",
  },
  {
    id: "google-sheets-board",
    category: "board",
    label: "Google Sheets Live Task Board (API v4)",
    connectionType: "board-sheets",
    secretName: "GOOGLE_BOARD_SA_PATH",
    promptLabel: "Path to Google Service Account JSON + Spreadsheet ID",
    description: "Sub-second direct Google Sheets API v4 Task Board (~60ms loopback / ~2s live).",
  },
  {
    id: "supabase-doorbell",
    category: "board",
    label: "Supabase Realtime WebSocket Doorbell",
    connectionType: "doorbell",
    secretName: "SUPABASE_PUBLISHABLE_KEY",
    promptLabel: "Supabase Project URL + Publishable Key for <1ms cross-machine wakeups",
    description: "Content-free WebSocket broadcast wakeup across Desktop, Hub, and Phone.",
  },
  {
    id: "obsidian-vault",
    category: "connector",
    label: "Obsidian / Markdown Context Vault",
    connectionType: "mcp",
    secretName: null,
    promptLabel: "Local path to your Markdown/Obsidian Vault folder",
    agents: ["claude", "codex", "gemini"],
    description: "Shared long-term memory, handoff specs, and decision logs.",
  },
  {
    id: "vapi-rest",
    category: "connector",
    label: "Vapi Voice AI (Lightweight REST)",
    connectionType: "rest",
    secretName: "VAPI_API_KEY",
    promptLabel: "Vapi API Key (read-only REST; avoids MCP process bloat)",
    access: "read-only",
    description: "Read-only REST connector for voice assistant call logs and transcripts.",
  },
  {
    id: "stripe-router",
    category: "connector",
    label: "Stripe Billing (Router-Gated)",
    connectionType: "router",
    secretName: "STRIPE_RESTRICTED_KEY",
    promptLabel: "Stripe Restricted Key (writes require explicit human YES per action)",
    writes: "per-action-approval",
    description: "Billing and checkout inspection; any spend/refund halts for explicit approval.",
  },
  {
    id: "search-console-helper",
    category: "connector",
    label: "Google Search Console (Local SA Helper)",
    connectionType: "local-helper",
    secretName: "GSC_SERVICE_ACCOUNT_PATH",
    promptLabel: "Path to Search Console Service Account JSON",
    description: "Local service-account helper for search rankings and CTR diagnostics.",
  },
]);

function connectServiceFromCatalog(manifest, serviceId, options = {}) {
  const item = SERVICE_DROPDOWN_CATALOG.find(s => s.id === serviceId);
  if (!item) {
    throw Object.assign(new Error(`Unknown service "${serviceId}"`), { code: "UNKNOWN_SERVICE" });
  }

  const next = structuredClone(manifest);
  next.connections = next.connections || {};
  next.agents = next.agents || {};

  if (item.category === "ai-agent") {
    next.agents[item.id] = {
      role: item.role,
      enabled: true,
    };
    return { manifest: next, connected: item };
  }

  if (item.id === "google-sheets-board") {
    next.board = {
      mode: "sheets",
      canonicalAuthority: "google-sheet",
      writeRule: "by-column-name-never-position",
      sheets: {
        boardId: options.boardId || next.board?.sheets?.boardId || "",
        saKeyEnv: item.secretName,
        realtimeUrlEnv: "SUPABASE_URL",
        realtimeKeyEnv: "SUPABASE_PUBLISHABLE_KEY",
      },
    };
    return { manifest: next, connected: item };
  }

  if (item.id === "obsidian-vault" && options.vaultPath) {
    next.vaultPath = options.vaultPath;
  }

  next.connections[item.id] = {
    type: item.connectionType,
    agents: item.agents || ["claude", "codex", "gemini"],
    ...(item.secretName ? { secretName: item.secretName } : {}),
    ...(item.command ? { command: item.command, args: item.args } : {}),
    ...(item.access ? { access: item.access } : {}),
    ...(item.writes ? { writes: item.writes } : {}),
  };

  return { manifest: next, connected: item };
}

module.exports = {
  OMARCHY_THEMES,
  SERVICE_DROPDOWN_CATALOG,
  connectServiceFromCatalog,
};
