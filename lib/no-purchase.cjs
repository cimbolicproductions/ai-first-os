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

// Antigravity has no fence here yet. Its `command(...)` deny rules need an exact match on Windows
// (checked live 2026-11-15: `command(*domains buy*)` let `echo vercel domains buy example.com` run),
// so it is not offered building work at all; see its entry in lib/harness-registry.cjs.

// A path that could mean something to a shell is refused outright rather than escaped.
const SAFE_PATH = /^[\p{L}\p{M}\p{N} _.:\\/()@+,=~-]+$/u;

/** Claude Code settings that run this file before every shell command (exit 2 refuses it). */
function claudeSettings({ node = process.execPath, script = __filename } = {}) {
  for (const part of [node, script]) {
    if (typeof part !== "string" || !SAFE_PATH.test(part)) {
      throw Object.assign(new Error("A path on this computer cannot be used safely in the purchase check."), { code: "UNSAFE_COMMAND_LINE" });
    }
  }
  return { hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: `"${node}" "${script}"`, timeout: 10 }] }] } };
}

const REFUSAL = "Refused: this command can spend the owner's money. Nothing is bought without the owner's yes. Stop and say what you would have bought and why.";

/** The hook itself. Anything it cannot read is refused too, so a broken check never waves a command through. */
function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
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

module.exports = { PURCHASE_PHRASES, isPurchaseCommand, openCodeConfig, claudeSettings };
