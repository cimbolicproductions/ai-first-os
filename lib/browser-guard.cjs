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
 * - Nothing is read, clicked or typed until that page has been opened, and after any navigation
 *   the job must look (a screenshot or reading the page) before it may click or type.
 * - Where the tab really is comes from Chrome's own report after every step, not from
 *   where the job asked to go. Seen live: Namecheap sends a signed-out browser from the
 *   domain's page to its login page, and only the step after the navigation shows it.
 *   Once the tab is anywhere but the domain's page, the job may only look and close.
 * - The only text it may type is one of the two nameservers, and it may only
 *   look, click, scroll and press a few plain keys.
 * After a step: if the browser has landed on a cart, checkout or payment page,
 * the whole job is stopped.
 *
 * - A click names an element, never a screen position, and only elements the
 *   page itself labels as being about nameservers (Nameservers, Custom DNS,
 *   the nameserver boxes, Save) can be clicked. The labels come from Chrome's own
 *   page reading. Anything that mentions money, renewal, add-ons, privacy, email,
 *   transfer or the account is out of reach even if it also says DNS, and so are
 *   toggles and links that go somewhere. This is what keeps a misclick off
 *   Auto-Renew, Renew, PremiumDNS and every Buy button on the domain's own page.
 *
 * Anything it cannot read or does not recognise is refused. The job also has a
 * step limit, and the registry's public record, not the agent, decides success.
 */
const fs = require("node:fs");

const NAMESERVERS = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"];
const PREFIX = "mcp__claude-in-chrome__";
const MAX_STEPS = 90;
const IN_TAB = new Set(["read_page", "get_page_text", "find", "navigate", "form_input", "computer", "tabs_close_mcp"]);
const LOOK_ONLY = new Set(["screenshot", "zoom", "wait", "scroll", "scroll_to", "hover"]);
const MOUSE = new Set(["left_click", "double_click", "triple_click"]);
const LOOK_TOOLS = new Set(["read_page", "get_page_text", "find"]);
/** Words an element must carry to be clicked or filled in this job. */
const CLICKABLE = /name ?servers?|custom ?dns|basic ?dns|\bns ?\d\b|\bsave\b/i;
/** Words that rule an element out even if it also says DNS or Save: money, renewal, add-ons, other services, the account. */
const NEVER = /premium|renew|buy|cart|check ?out|purchase|upgrade|order|\bpay|price|cost|\$|€|£|add-?on|subscri|trial|privacy|whois|\bssl\b|e-?mail|hosting|vpn|transfer|redirect|delete|remove|\block|unlock|sell|market|gift|coupon|promo|\bplan\b|billing|card|account|sign ?(in|out|up)|log ?(in|out)|password/i;
/** Kinds of element a click may reach. Toggles (checkbox, switch) are never among them: Auto-Renew is one. */
const CLICK_ROLES = new Set(["button", "combobox", "option", "menuitem", "listbox", "textbox", "generic", "radio", "listitem", "link", "cell", "img"]);
const MAX_REFS = 300;
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
 * { steps, tab, opened, looks, looked, away }. Returns { allow: true, state } with
 * the state to keep, or { allow: false, why }.
 */
function checkStep({ tool, input = {}, name, state = {} }) {
  if (!String(tool || "").startsWith(PREFIX)) return no("Only browser steps are checked here, and this was not one.");
  if (!validName(name)) return no("The job has no valid domain.");
  const steps = Number(state.steps) || 0;
  if (steps >= MAX_STEPS) return no("This job has used all its steps. Stop and report failed.");
  const next = {
    steps: steps + 1, tab: state.tab ?? null, opened: state.opened === true, looks: Number(state.looks) || 0,
    looked: state.looked === true, away: typeof state.away === "string" && state.away ? state.away : null,
    refs: Array.isArray(state.refs) ? state.refs.filter(ref => typeof ref === "string").slice(0, MAX_REFS) : [],
  };
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
    // Where it lands is only known after a look, so nothing is clicked or typed until then.
    // A new page has new elements: nothing from the last one can be clicked.
    Object.assign(next, { opened: true, looked: false, away: null, refs: [] });
    return yes;
  }
  if (!next.opened) return no("Open the domain's page in this tab first.");
  if (action === "read_page" || action === "get_page_text" || action === "find") return yes;
  const what = String(data.action || "");
  if (action === "computer" && LOOK_ONLY.has(what)) return yes;
  // Everything below changes the page. It needs a look first, and the tab on the domain's page.
  if (next.away) return no(`This tab left the domain's page and is now on ${next.away}. You may look, or close the tab, but not click or type here. If it asks you to sign in, stop and report not_signed_in.`);
  if (!next.looked) return no("Look at the page first (a screenshot, or read it) to see where the tab landed. Then act.");
  const reachable = ref => typeof ref === "string" && next.refs.includes(ref);
  const outOfReach = "That element is not about nameservers, so it cannot be used in this job. Read the page (read_page or find) and use only elements labelled Nameservers, Custom DNS, a nameserver box, or Save.";
  if (action === "form_input") {
    if (!reachable(data.ref)) return no(outOfReach);
    const value = typed(data.value);
    return NAMESERVERS.includes(value) || /^custom ?dns$/.test(value) ? yes : no("Only the two Vercel nameservers may be entered in this job.");
  }
  if (MOUSE.has(what)) {
    if (data.coordinate != null || data.start_coordinate != null || !data.ref) return no("Click an element by its ref from read_page or find, never by a position on the screen.");
    if (data.modifiers) return no("Plain clicks only in this job.");
    return reachable(data.ref) ? yes : no(outOfReach);
  }
  if (what === "type") return NAMESERVERS.includes(typed(data.text)) ? yes : no("Only the two Vercel nameservers may be typed in this job. Never type a password, a code or a payment detail.");
  if (what === "key") return KEYS.test(String(data.text || "").trim()) ? yes : no("That key is not part of this job.");
  return no("That mouse action is not part of this job.");
}

/** The address Chrome reports for one tab, from the "Tab Context" every step's reply ends with. Null when it is not listed. */
function tabAddress(response, tab) {
  if (tab == null) return null;
  // Each line reads: • tabId 1258425714: "Page title" ("https://the/address")
  for (const line of textParts(response).join("\n").split(/\r?\n/)) {
    const hit = /tabId (\d{1,12}): .*\("([^"]*)"\)\s*$/.exec(line.trim());
    if (hit && hit[1] === String(tab)) return hit[2];
  }
  return null;
}

/**
 * The elements a read_page or find reply lists that may be clicked in this job, by ref.
 * read_page lines read:  button "Save" [ref_21] type="submit"
 * find lines read:       ref_21 button "Save" in "Nameservers …"
 * Hidden elements, unlabelled ones, toggles, and links that go anywhere are left out.
 */
function clickableRefs(response) {
  const found = [];
  for (const raw of textParts(response).join("\n").split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-•*]\s*/, "");
    if (!line || /\(hidden\)/.test(line)) continue;
    const page = /^([a-z]+)(?: "([^"]*)")? \[(ref_\d+)\](.*)$/i.exec(line);
    const search = page ? null : /^(ref_\d+) ([a-z]+)(?: "([^"]*)")?(.*)$/i.exec(line);
    if (!page && !search) continue;
    const [role, label, ref, rest] = page ? [page[1], page[2], page[3], page[4]] : [search[2], search[3], search[1], search[4]];
    const kind = role.toLowerCase();
    if (!label || !CLICK_ROLES.has(kind) || !CLICKABLE.test(label) || NEVER.test(label)) continue;
    // Read_page shows where a link goes. One that leaves the page is not part of this job.
    const href = /href="([^"]*)"/.exec(rest || "")?.[1];
    if (kind === "link" && href !== undefined && !/^(#|javascript:)/i.test(href)) continue;
    if (NEVER.test(rest || "") && kind === "link") continue;
    found.push(ref);
  }
  return found;
}

/** The plain text a step's reply carries, part by part. Images and anything else are left out. */
function textParts(response) {
  if (typeof response === "string") return [response];
  if (Array.isArray(response)) return response.flatMap(textParts);
  if (response && typeof response === "object") {
    if (typeof response.text === "string") return [response.text];
    if (Array.isArray(response.content)) return textParts(response.content);
  }
  return [];
}

/** What a step's reply says about the job's tab: { looked, away } changes to keep, or {} when it says nothing. */
function afterStep({ tool, input = {}, response, name, tab }) {
  const action = String(tool || "").startsWith(PREFIX) ? String(tool).slice(PREFIX.length) : "";
  const where = tabAddress(response, tab);
  const change = {};
  if (where !== null && where !== "chrome://newtab/") {
    let host = "another page";
    try { host = new URL(where).host || where; } catch { /* keep the plain words */ }
    change.away = isJobPage(where, name) ? null : host;
  }
  const looked = LOOK_TOOLS.has(action) || (action === "computer" && ["screenshot", "zoom"].includes(String(input?.action || "")));
  if (looked && where !== null) change.looked = true;
  // Elements read off the domain's own page become reachable. Off it, nothing is.
  if ((action === "read_page" || action === "find") && where !== null && isJobPage(where, name)) change.refsSeen = clickableRefs(response);
  return change;
}

const textOf = response => {
  try { return (typeof response === "string" ? response : JSON.stringify(response)).replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '""'); } catch { return ""; }
};

/**
 * After a step: true when the job's own tab is on a page where money moves. When the job's
 * tab is known, only its address counts, so another tab in the group sitting on a cart
 * cannot stop a job by mistake. Before that, anything in the reply counts.
 */
function onMoneyPage({ tool, response, tab = null }) {
  const action = String(tool || "").startsWith(PREFIX) ? String(tool).slice(PREFIX.length) : "";
  if (!PREFIX || !action) return false;
  const where = tabAddress(response, tab);
  if (where !== null) return MONEY_PAGE.test(where);
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
 * read the same count. The lock is a file created only if it does not exist, and only its
 * holder removes it. A lock nobody releases is never broken by someone else: after two
 * seconds the step is refused, and a job whose check crashed simply stops.
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
        const stop = withLock(stateFile, () => {
          const state = readState(stateFile);
          if (onMoneyPage({ tool, response: event.tool_response, tab: state.tab })) return true;
          // The tab this job opened becomes the only tab it may work in.
          const tab = state.tab == null && tool === PREFIX + "tabs_create_mcp" ? createdTab(event.tool_response) : null;
          const known = state.tab ?? tab;
          const { refsSeen, ...change } = { ...(tab ? { tab } : {}), ...afterStep({ tool, input: event.tool_input || {}, response: event.tool_response, name, tab: known }) };
          if (refsSeen) change.refs = [...new Set([...(Array.isArray(state.refs) ? state.refs : []), ...refsSeen])].slice(-MAX_REFS);
          if (change.away) change.refs = [];
          if (Object.keys(change).length) writeState(stateFile, { ...state, ...change });
          return false;
        });
        if (stop) process.stdout.write(JSON.stringify({ continue: false, stopReason: "Stopped: the browser reached a page where money moves. Nothing is bought in this job." }));
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

module.exports = { checkStep, afterStep, clickableRefs, tabAddress, onMoneyPage, createdTab, isJobPage, guardSettings, NAMESERVERS, MAX_STEPS };
