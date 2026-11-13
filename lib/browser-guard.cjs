"use strict";

/**
 * The fence around a browser job. Claude Code runs this before and after every
 * browser step (as a hook), and a step that is not part of "set two nameservers
 * for one domain" is refused by this program, whatever the agent was told or
 * whatever a web page says. Rules in a work order are a request; this is the lock.
 *
 * Before a step:
 * - The job works in one tab: the one it opens itself. Every step that reads,
 *   clicks, types or navigates must name that tab, and no other tab can be
 *   touched or closed.
 * - The only address that tab may be sent to is that domain's page in Namecheap's
 *   control panel, compared after the address is parsed, never as a string prefix.
 * - Nothing is read, clicked or typed until that page has been opened.
 * - The only text it may type is one of the two nameservers, and it may only
 *   look, click, scroll and press a few plain keys.
 * After a step: if the browser has landed on a cart, checkout or payment page,
 * the whole job is stopped.
 *
 * Anything it cannot read or does not recognise is refused. What it cannot see
 * is where a click lands before it happens, so the job also has a step limit,
 * and the registry's public record, not the agent, decides success.
 */
const fs = require("node:fs");

const NAMESERVERS = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"];
const PREFIX = "mcp__claude-in-chrome__";
const MAX_STEPS = 90;
const IN_TAB = new Set(["read_page", "get_page_text", "find", "navigate", "form_input", "computer", "tabs_close_mcp"]);
const MOUSE = new Set(["screenshot", "left_click", "double_click", "triple_click", "scroll", "scroll_to", "hover", "wait", "zoom"]);
const KEYS = /^(?:(?:enter|return|tab|backspace|delete|escape|esc|up|down|left|right|home|end|(?:ctrl|cmd|meta)\+a)(?:\s+|$))+$/i;
const MONEY_PAGE = /https?:\/\/[^\s"'<>]*\b(?:cart|checkout|shoppingcart|payment|billing|order|funds|topup|renew)\b/i;
/**
 * Letters in any language, digits, and characters that mean nothing to a shell inside
 * double quotes, on Windows and elsewhere. No $, backquote, %, !, ^, quotes, ; & | < > or newlines.
 */
const SAFE_PATH = /^[\p{L}\p{M}\p{N} _.:\\/()@+,=~-]+$/u;
/** Claude in Chrome needs one look at its own tab group before it can open a tab. Two, if the first created the group. */
const MAX_CONTEXT_LOOKS = 2;

const validName = name => typeof name === "string" && name.length <= 80 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,24})+$/.test(name);
const typed = text => String(text ?? "").trim().toLowerCase().replace(/\.$/, "");
const no = why => ({ allow: false, why });

/** True only for the one page this job may open: parsed first, then compared part by part. */
function isJobPage(address, name) {
  let url;
  try { url = new URL(String(address)); } catch { return false; }
  return url.protocol === "https:" && url.hostname === "ap.www.namecheap.com" && url.port === "" &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "" &&
    url.pathname === `/domains/domaincontrolpanel/${name}/domain` &&
    // The parser quietly folds "/../" away. An address that needed folding is not the plain one.
    !/\.\.|%2e|\\|%5c|@/i.test(String(address));
}

/**
 * Decides one step before it runs. `state` is what this job has done so far:
 * { steps, tab, opened }. Returns { allow: true, state } with the state to keep,
 * or { allow: false, why }.
 */
function checkStep({ tool, input = {}, name, state = {} }) {
  if (!String(tool || "").startsWith(PREFIX)) return no("Only browser steps are checked here, and this was not one.");
  if (!validName(name)) return no("The job has no valid domain.");
  const steps = Number(state.steps) || 0;
  if (steps >= MAX_STEPS) return no("This job has used all its steps. Stop and report failed.");
  const next = { steps: steps + 1, tab: state.tab ?? null, opened: state.opened === true, looks: Number(state.looks) || 0 };
  const yes = { allow: true, state: next };
  const action = String(tool).slice(PREFIX.length);
  const data = input && typeof input === "object" ? input : {};

  // The list of the agent's tab group is needed once to open a tab. After that the job has
  // its own tab and no reason to see what else is open.
  if (action === "tabs_context_mcp") {
    if (next.tab !== null) return no("This job has its tab. It does not need to list the others.");
    if (next.looks >= MAX_CONTEXT_LOOKS) return no("The tab list was already read. Open a new tab for this job with tabs_create_mcp.");
    next.looks += 1;
    return yes;
  }
  if (action === "tabs_create_mcp") return next.tab === null ? yes : no("This job already has its tab. Work in that one.");
  if (!IN_TAB.has(action)) return no("That browser tool is not part of this job.");

  // Everything else happens in the job's own tab and nowhere else.
  if (next.tab === null) return no("Open a new tab for this job first, with tabs_create_mcp.");
  if (String(data.tabId ?? "") !== String(next.tab)) return no(`Work only in the tab this job opened (tab ${next.tab}), and name it in every step.`);
  if (action === "tabs_close_mcp") return yes;
  if (action === "navigate") {
    if (!isJobPage(data.url, name)) return no(`Only https://ap.www.namecheap.com/domains/domaincontrolpanel/${name}/domain may be opened in this job.`);
    next.opened = true;
    return yes;
  }
  if (!next.opened) return no("Open the domain's page in this tab first.");
  if (action === "read_page" || action === "get_page_text" || action === "find") return yes;
  if (action === "form_input") {
    const value = typed(data.value);
    return NAMESERVERS.includes(value) || /^custom ?dns$/.test(value) ? yes : no("Only the two Vercel nameservers may be entered in this job.");
  }
  const what = String(data.action || "");
  if (MOUSE.has(what)) return yes;
  if (what === "type") return NAMESERVERS.includes(typed(data.text)) ? yes : no("Only the two Vercel nameservers may be typed in this job. Never type a password, a code or a payment detail.");
  if (what === "key") return KEYS.test(String(data.text || "").trim()) ? yes : no("That key is not part of this job.");
  return no("That mouse action is not part of this job.");
}

const textOf = response => {
  try { return (typeof response === "string" ? response : JSON.stringify(response)).replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '""'); } catch { return ""; }
};

/** After a step: true when what came back shows the browser on a page where money moves. */
function onMoneyPage({ tool, response }) {
  const action = String(tool || "").startsWith(PREFIX) ? String(tool).slice(PREFIX.length) : "";
  if (!["navigate", "tabs_context_mcp", "tabs_create_mcp", "computer"].includes(action)) return false;
  return MONEY_PAGE.test(textOf(response));
}

/** The number of the tab a tabs_create_mcp step opened, read from what it returned. Null when it does not say. */
function createdTab(response) {
  const text = textOf(response);
  return /tab[ _]?id["'\s:=]{1,6}(\d{1,12})/i.exec(text)?.[1] || /\bid["'\s:=]{1,6}(\d{4,12})\b/i.exec(text)?.[1] || null;
}

/** The job's state on disk. A file that is there but cannot be read is an error, never "a fresh start". */
function readState(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const state = JSON.parse(raw);
  if (!state || typeof state !== "object") throw new Error("bad state");
  return state;
}

/**
 * Runs fn while holding this job's lock, so two steps checked at the same moment cannot both
 * read the same count. The lock is a file created only if it does not exist. A lock left by a
 * check that crashed is cleared after ten seconds. No lock within two seconds: refused.
 */
function withLock(stateFile, fn) {
  const lock = stateFile + ".lock";
  const give = Date.now() + 2000;
  for (;;) {
    let handle = null;
    try {
      handle = fs.openSync(lock, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { force: true }); } catch { /* gone already */ }
      if (Date.now() > give) throw new Error("busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }
    try {
      return fn();
    } finally {
      fs.closeSync(handle);
      fs.rmSync(lock, { force: true });
    }
  }
}

function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
  fs.renameSync(tmp, file);
}

/** The hook settings Claude Code loads for one job. Every part of the command is checked before it is placed there. */
function guardSettings({ name, counterFile, node = process.execPath, script = __filename }) {
  if (!validName(name)) throw Object.assign(new Error("Not a domain name."), { code: "BAD_NAME" });
  for (const part of [node, script, counterFile]) {
    // A path that could mean something to a shell is refused outright rather than escaped.
    if (typeof part !== "string" || !SAFE_PATH.test(part)) throw Object.assign(new Error("A path on this computer cannot be used safely in the browser guard."), { code: "UNSAFE_COMMAND_LINE" });
  }
  const command = `"${node}" "${script}" ${name} "${counterFile}"`;
  const hook = [{ matcher: PREFIX + ".*", hooks: [{ type: "command", command, timeout: 10 }] }];
  return { hooks: { PreToolUse: hook, PostToolUse: hook } };
}

function main() {
  const [name, stateFile] = process.argv.slice(2);
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const event = JSON.parse(raw);
      const tool = String(event.tool_name || "");
      if (!stateFile) throw new Error("no state file");
      if (event.hook_event_name === "PostToolUse") {
        if (onMoneyPage({ tool, response: event.tool_response })) {
          process.stdout.write(JSON.stringify({ continue: false, stopReason: "Stopped: the browser reached a page where money moves. Nothing is bought in this job." }));
          return process.exit(0);
        }
        // The tab this job opened becomes the only tab it may work in.
        if (tool === PREFIX + "tabs_create_mcp") {
          withLock(stateFile, () => {
            const state = readState(stateFile);
            const tab = createdTab(event.tool_response);
            if (state.tab == null && tab) writeState(stateFile, { ...state, tab });
          });
        }
        return process.exit(0);
      }
      if (event.hook_event_name !== "PreToolUse") throw new Error("unknown event");
      const verdict = withLock(stateFile, () => {
        const checked = checkStep({ tool, input: event.tool_input || {}, name, state: readState(stateFile) });
        if (checked.allow) writeState(stateFile, checked.state);
        return checked;
      });
      if (!verdict.allow) {
        process.stderr.write(verdict.why);
        return process.exit(2);
      }
      process.exit(0);
    } catch {
      // Anything unreadable is refused: exit code 2 is the one that blocks the step.
      process.stderr.write("The browser guard could not check this step, so it was refused.");
      process.exit(2);
    }
  });
}

if (require.main === module) main();

module.exports = { checkStep, onMoneyPage, createdTab, isJobPage, guardSettings, NAMESERVERS, MAX_STEPS };
