"use strict";

/**
 * The fence around a browser job. Claude Code runs this before and after every
 * browser step (as a hook), and a step that is not part of "set two nameservers
 * for one domain" is refused by this program, whatever the agent was told or
 * whatever a web page says. Rules in a work order are a request; this is the lock.
 *
 * Before a step: the only address it may open is that domain's page in Namecheap's
 * control panel, the only text it may type is one of the two nameservers, and it
 * may only look, click, scroll and press a few plain keys.
 * After a step: if the browser has landed on a cart, checkout or payment page,
 * the whole job is stopped.
 *
 * What it cannot see is what a click lands on before it happens, so the job also
 * has a step limit, and the registry's public record, not the agent, decides success.
 */
const fs = require("node:fs");

const NAMESERVERS = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"];
const PREFIX = "mcp__claude-in-chrome__";
const MAX_STEPS = 90;
const LOOK = new Set(["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "read_page", "get_page_text", "find"]);
const MOUSE = new Set(["screenshot", "left_click", "double_click", "triple_click", "scroll", "scroll_to", "hover", "wait", "zoom"]);
const KEYS = /^(?:(?:enter|return|tab|backspace|delete|escape|esc|up|down|left|right|home|end|(?:ctrl|cmd|meta)\+a)(?:\s+|$))+$/i;
const MONEY_PAGE = /https?:\/\/[^\s"'<>]*\b(?:cart|checkout|shoppingcart|payment|billing|order|funds|topup|renew)\b/i;

const validName = name => typeof name === "string" && name.length <= 80 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,24})+$/.test(name);
const typed = text => String(text ?? "").trim().toLowerCase().replace(/\.$/, "");

/** Decides one step before it runs. Returns { allow: true } or { allow: false, why }. */
function checkStep({ tool, input = {}, name, steps = 0 }) {
  if (!String(tool).startsWith(PREFIX)) return { allow: true };
  if (!validName(name)) return { allow: false, why: "The job has no valid domain." };
  if (steps >= MAX_STEPS) return { allow: false, why: "This job has used all its steps. Stop and report failed." };
  const action = String(tool).slice(PREFIX.length);
  if (LOOK.has(action)) return { allow: true };
  if (action === "navigate") {
    const home = `https://ap.www.namecheap.com/domains/domaincontrolpanel/${name}/domain`;
    const url = String(input.url || "");
    return url === home || url.startsWith(home + "/") || url.startsWith(home + "?")
      ? { allow: true }
      : { allow: false, why: `Only ${home} may be opened in this job.` };
  }
  if (action === "form_input") {
    const value = typed(input.value);
    return NAMESERVERS.includes(value) || /^custom ?dns$/.test(value)
      ? { allow: true }
      : { allow: false, why: "Only the two Vercel nameservers may be entered in this job." };
  }
  if (action === "computer") {
    const what = String(input.action || "");
    if (MOUSE.has(what)) return { allow: true };
    if (what === "type") {
      return NAMESERVERS.includes(typed(input.text))
        ? { allow: true }
        : { allow: false, why: "Only the two Vercel nameservers may be typed in this job. Never type a password, a code or a payment detail." };
    }
    if (what === "key") return KEYS.test(String(input.text || "").trim()) ? { allow: true } : { allow: false, why: "That key is not part of this job." };
    return { allow: false, why: "That mouse action is not part of this job." };
  }
  return { allow: false, why: "That browser tool is not part of this job." };
}

/** After a step: true when what came back shows the browser on a page where money moves. */
function onMoneyPage({ tool, response }) {
  const action = String(tool).startsWith(PREFIX) ? String(tool).slice(PREFIX.length) : "";
  if (!["navigate", "tabs_context_mcp", "tabs_create_mcp", "computer"].includes(action)) return false;
  let text;
  try { text = typeof response === "string" ? response : JSON.stringify(response); } catch { return false; }
  // Screenshots are long runs of image data; only real text is worth reading.
  return MONEY_PAGE.test(String(text || "").replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '""'));
}

function countStep(file) {
  let steps = 0;
  try { steps = Number(fs.readFileSync(file, "utf8")) || 0; } catch { /* first step */ }
  try { fs.writeFileSync(file, String(steps + 1), "utf8"); } catch { /* counted next time */ }
  return steps;
}

/** The hook settings Claude Code loads for one job. The domain is checked before it is placed here. */
function guardSettings({ name, counterFile, node = process.execPath, script = __filename }) {
  if (!validName(name)) throw Object.assign(new Error("Not a domain name."), { code: "BAD_NAME" });
  if (/["\r\n]/.test(node + script + counterFile)) throw Object.assign(new Error("Unsafe path."), { code: "UNSAFE_COMMAND_LINE" });
  const command = `"${node}" "${script}" ${name} "${counterFile}"`;
  const hook = [{ matcher: PREFIX + ".*", hooks: [{ type: "command", command, timeout: 10 }] }];
  return { hooks: { PreToolUse: hook, PostToolUse: hook } };
}

function main() {
  const [name, counterFile] = process.argv.slice(2);
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const event = JSON.parse(raw);
      const tool = String(event.tool_name || "");
      if (event.hook_event_name === "PostToolUse") {
        if (onMoneyPage({ tool, response: event.tool_response })) {
          process.stdout.write(JSON.stringify({ continue: false, stopReason: "Stopped: the browser reached a page where money moves. Nothing is bought in this job." }));
        }
        return process.exit(0);
      }
      const verdict = checkStep({ tool, input: event.tool_input || {}, name, steps: counterFile ? countStep(counterFile) : 0 });
      if (verdict.allow) return process.exit(0);
      process.stderr.write(verdict.why);
      process.exit(2);
    } catch {
      // Anything unreadable is refused: exit code 2 is the one that blocks the step.
      process.stderr.write("The browser guard could not read this step, so it was refused.");
      process.exit(2);
    }
  });
}

if (require.main === module) main();

module.exports = { checkStep, onMoneyPage, guardSettings, NAMESERVERS, MAX_STEPS };
