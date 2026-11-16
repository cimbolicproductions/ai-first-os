"use strict";

/**
 * Build agents run shell commands, and the command lines on this computer can spend money:
 * Vercel's can buy a domain or add a paid Marketplace product, and the registrars' APIs can
 * register or renew a name. The owner's rule is that nothing is bought without their yes,
 * so these commands are refused before they run, whatever the agent was told.
 *
 * One list, read two ways: as a pattern for Claude Code's hook (below) and as deny rules
 * OpenCode applies itself. An asterisk stands for anything; a space for any run of spaces.
 */
const PURCHASE_PHRASES = Object.freeze([
  "domains buy",
  "domains transfer-in",
  "vercel install",
  "vercel i ",
  "vercel integration add",
  "vc install",
  "vc i ",
  "vc integration add",
  "api.vercel.com/*/registrar/",
  "namecheap.domains.create",
  "namecheap.domains.renew",
  "namecheap.domains.reactivate",
  "namecheap.domains.transfer",
]);

const escape = text => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const PURCHASE = new RegExp(PURCHASE_PHRASES.map(p => escape(p).replace(/\*/g, ".*").replace(/ /g, "\\s+")).join("|"), "i");

/** Whether a shell command could buy something. */
function isPurchaseCommand(command) {
  return PURCHASE.test(String(command || ""));
}

/** The same list as OpenCode permission rules: a matching shell command is refused outright. */
function openCodeConfig() {
  const bash = {};
  for (const phrase of PURCHASE_PHRASES) bash[`*${phrase}*`] = "deny";
  return JSON.stringify({ permission: { bash } });
}

// Antigravity's own `command(...)` deny rules need an exact match on Windows (checked live 2026-11-15:
// `command(*domains buy*)` let `echo vercel domains buy example.com` run), so it gets this same list
// through its PreToolUse hook instead: JSON in on stdin, a JSON decision out (antigravityDecision below).

const HOOK_NAME = "ai-first-os-no-purchase";

/**
 * Puts this check in Antigravity's global hooks file (~/.gemini/config/hooks.json), keeping any other hooks
 * there, and confirms it by reading the file back. Returns false, and changes nothing, when that cannot be
 * done safely (a file it cannot read, a path a shell could misread): the caller then keeps Antigravity in the
 * mode where every command is refused. In the owner's own Antigravity sessions the hook only refuses buying.
 */
function ensureAntigravityGuard({ home = require("node:os").homedir(), node = process.execPath, script = __filename, repairOnly = false } = {}) {
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    for (const part of [node, script]) if (typeof part !== "string" || !SAFE_PATH.test(part)) return false;
    const file = path.join(home, ".gemini", "config", "hooks.json");
    let hooks = {};
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
      hooks = text.trim() ? JSON.parse(text) : {};
      if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
    }
    if (repairOnly && hooks[HOOK_NAME]?.enabled !== true) return false;
    const entry = { enabled: true, PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `"${node}" "${script}" --agy`, timeout: 15 }] }] };
    if (JSON.stringify(hooks[HOOK_NAME]) !== JSON.stringify(entry)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ ...hooks, [HOOK_NAME]: entry }, null, 2), "utf8");
      fs.renameSync(temp, file);
    }
    const back = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return JSON.stringify(back[HOOK_NAME]) === JSON.stringify(entry);
  } catch {
    return false;
  }
}

/**
 * Antigravity's PreToolUse answer. A command that could buy is denied, and so is anything unreadable.
 * Inside the app's own background runs (AIOS_AGY_WORKER=1) everything else is approved without a prompt,
 * since nobody is there to answer one; in the owner's own sessions it is left to their usual rules.
 */
function antigravityDecision(raw, env = process.env) {
  let call;
  try {
    call = JSON.parse(raw)?.toolCall;
  } catch {
    return { decision: "deny", reason: "Refused: the purchase check could not read this request." };
  }
  if (!call || typeof call !== "object") return { decision: "deny", reason: "Refused: the purchase check could not read this request." };
  if (call.name === "run_command") {
    const command = call.args?.CommandLine;
    if (typeof command !== "string") return { decision: "deny", reason: "Refused: the purchase check could not read this command." };
    if (isPurchaseCommand(command)) return { decision: "deny", reason: REFUSAL };
  }
  // Only the tools a build uses on this computer are approved without a prompt (the five seen in a live
  // build probe, 2026-11-15). Anything else, such as a connected service or a browser, is left to
  // Antigravity's own rules, and a background run cannot answer their prompt, so it does not happen.
  const approved = env.AIOS_AGY_WORKER === "1" && AGY_BUILD_TOOLS.includes(call.name);
  return { decision: approved ? "auto_approve" : "allow" };
}

const AGY_BUILD_TOOLS = Object.freeze(["run_command", "read_file", "write_file", "edit_file", "search_web"]);

// A path that could mean something to a shell is refused outright rather than escaped.
const SAFE_PATH = /^[\p{L}\p{M}\p{N} _.:\\/()@+,=~-]+$/u;

/**
 * Claude Code settings that run this file before every shell command (exit 2 refuses it).
 * With blockConnectors, every connected-service tool (mcp__...) is refused too. A background run that writes
 * has no permission prompts, and the owner's connectors can send mail, buy a domain, charge a card or change
 * a live database (seen 2026-11-15: 1,170 such tools in a headless run), so none of them is reachable there.
 */
function claudeSettings({ node = process.execPath, script = __filename, blockConnectors = false } = {}) {
  for (const part of [node, script]) {
    if (typeof part !== "string" || !SAFE_PATH.test(part)) {
      throw Object.assign(new Error("A path on this computer cannot be used safely in the purchase check."), { code: "UNSAFE_COMMAND_LINE" });
    }
  }
  const check = extra => ({ type: "command", command: `"${node}" "${script}"${extra}`, timeout: 10 });
  return { hooks: { PreToolUse: [
    { matcher: "Bash|PowerShell", hooks: [check("")] },
    ...(blockConnectors ? [{ matcher: "mcp__.*", hooks: [check(" --connector")] }] : []),
  ] } };
}

const REFUSAL = "Refused: this command can spend the owner's money. Nothing is bought without the owner's yes. Stop and say what you would have bought and why.";
const CONNECTOR_REFUSAL = "Refused: connected services (mail, payments, hosting, databases and the rest) are not available to background runs. Do the work with files and commands in the project, and say in your answer what you would have used the service for.";

/** The hook itself. Anything it cannot read is refused too, so a broken check never waves a command through. */
function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  if (process.argv.includes("--agy")) {
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify(antigravityDecision(raw)));
      process.exit(0);
    });
    return;
  }
  // A connected-service tool in a background run: refused whatever it is, without reading it.
  if (process.argv.includes("--connector")) {
    process.stderr.write(CONNECTOR_REFUSAL);
    process.exit(2);
  }
  process.stdin.on("end", () => {
    let command;
    try {
      command = JSON.parse(raw).tool_input?.command;
    } catch {
      command = undefined;
    }
    if (typeof command !== "string" || isPurchaseCommand(command)) {
      process.stderr.write(typeof command === "string" ? REFUSAL : "Refused: the purchase check could not read this command.");
      process.exit(2);
    }
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { PURCHASE_PHRASES, isPurchaseCommand, openCodeConfig, claudeSettings, antigravityDecision, ensureAntigravityGuard };
