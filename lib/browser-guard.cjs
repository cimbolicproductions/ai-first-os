"use strict";

/**
 * The fence around a browser job. Claude Code runs this before and after every
 * browser step (as a hook), and a step that is not part of "set two nameservers
 * for one domain" is refused by this program, whatever the agent was told or
 * whatever a web page says. Rules in a work order are a request; this is the lock.
 * The rule it serves: no agent buys anything, or turns on anything that costs
 * money, without the owner's yes.
 *
 * Where it may go:
 * - One tab, the one the job opens itself. Every step names that tab; no other
 *   tab can be read, used or closed. The tab list is read at most twice, and only
 *   before the job has its tab.
 * - The only address that tab may be sent to is that domain's page in Namecheap's
 *   control panel, compared after the address is parsed, never as a string prefix.
 * - Where the tab really is comes from the "Tab Context" Chrome reports after every
 *   step, not from where the job asked to go. Seen live: Namecheap sends a signed-out
 *   browser to its login page, and only the step after the navigation shows it.
 *   Once the tab is anywhere but the domain's page, the job may only look and close.
 *
 * What it may change, one thing at a time:
 * - Only two kinds of change exist: a plain click on an element, and filling a box
 *   with one of the two nameservers (or choosing Custom DNS). No keyboard keys, no
 *   typing, no double clicks, no clicking by screen position, no modifier keys.
 * - An element can be changed only if the latest page reading, taken on the domain's
 *   page after the last change finished, listed it as being about nameservers: its
 *   own label names nameservers or Custom DNS, or it is a plain Save or Add button
 *   whose surroundings are the Nameservers section. Anything whose label or
 *   surroundings mention money, renewal, ordering, confirming, add-ons, privacy,
 *   email, transfer or the account is out of reach, and so are toggles (Auto-Renew is
 *   one) and links that leave the page.
 * - Each change uses up that reading. The next change needs a fresh one.
 * - While a change is in flight, nothing else may change the page and no reading
 *   may start, and while a reading is in flight, no change may start. Steps the
 *   agent sends together cannot slip past each other.
 * - A change needs Chrome's own report, after the last step, that the tab is on the
 *   domain's page. A report that cannot be read counts as "not on the page".
 *
 * After a step: the job's tab on a cart, checkout or payment address stops the job.
 * Anything this program cannot read or does not recognise is refused. The job has a
 * step limit, and the registry's public record, not the agent, decides success.
 */
const fs = require("node:fs");

const NAMESERVERS = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"];
const PREFIX = "mcp__claude-in-chrome__";
const MAX_STEPS = 90;
const IN_TAB = new Set(["read_page", "get_page_text", "find", "navigate", "form_input", "computer", "tabs_close_mcp"]);
const LOOK_ONLY = new Set(["screenshot", "zoom", "wait", "scroll", "scroll_to"]);
const READS = new Set(["read_page", "find"]);
const LOOK_TOOLS = new Set(["read_page", "get_page_text", "find"]);
/** A label that names nameservers itself. */
const NAMES_NAMESERVERS = /name ?servers?|\bns ?\d\b|custom ?dns|basic ?dns/i;
/** A plain button that is only safe inside the Nameservers section. */
const PLAIN_BUTTON = /^(?:save|save changes|add|add nameserver|done|apply|✓|check)$/i;
/** Words that rule an element out, in its label or its surroundings. */
const NEVER = /premium|renew|buy|cart|check ?out|purchase|upgrade|order|\bpay|price|cost|total|charge|invoice|confirm|\$|€|£|add-?on|subscri|trial|privacy|whois|\bssl\b|e-?mail|hosting|vpn|transfer|redirect|delete|remove|\block|unlock|sell|market|gift|coupon|promo|\bplan\b|billing|card|account|sign ?(in|out|up)|log ?(in|out)|password/i;
/** Kinds of element a change may reach. Toggles (checkbox, switch) are never among them. */
const CHANGE_ROLES = new Set(["button", "combobox", "option", "menuitem", "listbox", "textbox", "generic", "radio", "listitem", "link"]);
const MAX_REFS = 60;
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
const actionOf = tool => (String(tool || "").startsWith(PREFIX) ? String(tool).slice(PREFIX.length) : "");
/** The two kinds of change. Everything else either only looks, or is refused. */
const isChange = (action, data) => action === "form_input" || (action === "computer" && String(data?.action || "") === "left_click");

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

/** The job's state, every field present and of the right kind. */
function cleanState(state = {}) {
  return {
    steps: Number(state.steps) || 0,
    tab: state.tab ?? null,
    opened: state.opened === true,
    looks: Number(state.looks) || 0,
    looked: state.looked === true,
    away: typeof state.away === "string" && state.away ? state.away : null,
    // Chrome's last report put the tab on the domain's page.
    confirmed: state.confirmed === true,
    refs: Array.isArray(state.refs) ? state.refs.filter(ref => typeof ref === "string").slice(0, MAX_REFS) : [],
    pending: state.pending === true,
    reading: Math.max(0, Number(state.reading) || 0),
    changes: Number(state.changes) || 0,
  };
}

/**
 * Decides one step before it runs. Returns { allow: true, state } with the state to
 * keep, or { allow: false, why }.
 */
function checkStep({ tool, input = {}, name, state = {}, lookOnly = false }) {
  if (!String(tool || "").startsWith(PREFIX)) return no("Only browser steps are checked here, and this was not one.");
  if (!validName(name)) return no("The job has no valid domain.");
  const next = cleanState(state);
  if (next.steps >= MAX_STEPS) return no("This job has used all its steps. Stop and report failed.");
  next.steps += 1;
  const yes = { allow: true, state: next };
  const action = actionOf(tool);
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
  const busy = "The last change is still being made. Wait for it to finish, then read the page again.";
  if (action === "navigate") {
    if (next.pending) return no(busy);
    if (!isJobPage(data.url, name)) return no(`Only https://ap.www.namecheap.com/domains/domaincontrolpanel/${name}/domain may be opened in this job.`);
    // A new page: where it landed is unknown until Chrome reports it, and nothing from the last page can be changed.
    Object.assign(next, { opened: true, looked: false, away: null, confirmed: false, refs: [] });
    return yes;
  }
  if (!next.opened) return no("Open the domain's page in this tab first.");
  if (READS.has(action)) {
    if (next.pending) return no(busy);
    next.reading += 1;
    return yes;
  }
  if (action === "get_page_text") return yes;
  const what = String(data.action || "");
  if (action === "computer" && LOOK_ONLY.has(what)) return yes;
  // A look-only job may read the page and close its tab. Nothing on the page can be used.
  if (lookOnly) return no("This is a look-only job. Nothing on the page may be clicked, typed or changed.");
  if (!isChange(action, data)) {
    if (what === "type" || what === "key") return no("Typing and keys are not used in this job. Fill a nameserver box with form_input, by its ref.");
    return no("Only plain clicks and form_input are used in this job.");
  }

  // A change. Every condition below must hold.
  if (next.away) return no(`This tab left the domain's page and is now on ${next.away}. You may look, or close the tab, but not click or type here. If it asks you to sign in, stop and report not_signed_in.`);
  if (next.pending) return no(busy);
  if (next.reading > 0) return no("A page reading is still in flight. Wait for it, then make one change.");
  if (!next.looked || !next.confirmed) return no("Read the page first (read_page or find) so Chrome shows the tab is on the domain's page. Then make one change.");
  if (action === "computer") {
    if (data.coordinate != null || data.start_coordinate != null || !data.ref) return no("Click an element by its ref from read_page or find, never by a position on the screen.");
    if (data.modifiers) return no("Plain clicks only in this job.");
  }
  if (typeof data.ref !== "string" || !next.refs.includes(data.ref)) {
    return no("That element is not about nameservers in the latest reading of the page, so it cannot be used. Read the page again (find \"nameservers\") and use only elements labelled for nameservers, Custom DNS, or the Save in the Nameservers section. Each change needs a fresh reading.");
  }
  if (action === "form_input") {
    const value = typed(data.value);
    if (!NAMESERVERS.includes(value) && !/^custom ?dns$/.test(value)) return no("Only the two Vercel nameservers may be entered in this job.");
  }
  // One change at a time, and it uses up the reading it came from.
  Object.assign(next, { pending: true, refs: [], changes: next.changes + 1 });
  return yes;
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
 * The elements a read_page or find reply lists that may be changed in this job, by ref.
 * read_page lines read:  button "Save" [ref_21] type="submit"
 * find lines read:       ref_21 button "Save" in "NAMESERVERS Custom DNS …"
 * An element qualifies when its own label names nameservers or Custom DNS, or when it is
 * a plain Save or Add button whose surroundings (only find reports them) are the
 * Nameservers section. Money words in the label or the surroundings, toggles, hidden
 * elements, unlabelled ones and links that leave the page never qualify.
 */
function changeableRefs(response) {
  const found = [];
  for (const raw of textParts(response).join("\n").split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-•*]\s*/, "");
    if (!line || /\(hidden\)/.test(line)) continue;
    const page = /^([a-z]+)(?: "([^"]*)")? \[(ref_\d+)\](.*)$/i.exec(line);
    const search = page ? null : /^(ref_\d+) ([a-z]+)(?: "([^"]*)")?(.*)$/i.exec(line);
    if (!page && !search) continue;
    const [role, label, ref, rest] = page ? [page[1], page[2], page[3], page[4] || ""] : [search[2], search[3], search[1], search[4] || ""];
    const kind = role.toLowerCase();
    const context = search ? (/\bin "([^"]*)"/.exec(rest)?.[1] || "") : "";
    if (!label || !CHANGE_ROLES.has(kind) || NEVER.test(label) || NEVER.test(context)) continue;
    const named = NAMES_NAMESERVERS.test(label);
    const plainInSection = kind === "button" && PLAIN_BUTTON.test(label.trim()) && /name ?servers?/i.test(context);
    if (!named && !plainInSection) continue;
    // Read_page shows where a link goes. One that leaves the page is not part of this job.
    const href = /href="([^"]*)"/.exec(rest)?.[1];
    if (kind === "link" && href !== undefined && !/^(#|javascript:)/i.test(href)) continue;
    found.push(ref);
  }
  return found.slice(0, MAX_REFS);
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

/** After a step: the job's state as Chrome's own report leaves it. */
function afterStep({ tool, input = {}, response, name, state = {} }) {
  const next = cleanState(state);
  const action = actionOf(tool);
  const data = input && typeof input === "object" ? input : {};
  const where = tabAddress(response, next.tab);
  if (where !== null && where !== "chrome://newtab/") {
    let host = "another page";
    try { host = new URL(where).host || where; } catch { /* keep the plain words */ }
    const onPage = isJobPage(where, name);
    next.away = onPage ? null : host;
    next.confirmed = onPage;
  } else if (next.opened && action !== "tabs_close_mcp") {
    // Chrome did not say where the tab is. Until it does, nothing may be changed.
    next.confirmed = false;
  }
  if (where !== null && (LOOK_TOOLS.has(action) || (action === "computer" && ["screenshot", "zoom"].includes(String(data.action || ""))))) next.looked = true;
  if (READS.has(action)) {
    next.reading = Math.max(0, next.reading - 1);
    // The latest reading on the domain's page, and only that, says what may be changed next.
    next.refs = where !== null && isJobPage(where, name) && !next.pending ? changeableRefs(response) : [];
  }
  if (isChange(action, data)) next.pending = false;
  if (next.away) next.refs = [];
  return next;
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
  const action = actionOf(tool);
  if (!action) return false;
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
 * read the same state. The lock is a file created only if it does not exist, and only its
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
function guardSettings({ name, counterFile, node = process.execPath, script = __filename, lookOnly = false }) {
  if (!validName(name)) throw Object.assign(new Error("Not a domain name."), { code: "BAD_NAME" });
  for (const part of [node, script, counterFile]) {
    // A path that could mean something to a shell is refused outright rather than escaped.
    if (typeof part !== "string" || !SAFE_PATH.test(part)) throw Object.assign(new Error("A path on this computer cannot be used safely in the browser guard."), { code: "UNSAFE_COMMAND_LINE" });
  }
  const command = `"${node}" "${script}" ${name} "${counterFile}"${lookOnly ? " look" : ""}`;
  const hook = [{ matcher: PREFIX + ".*", hooks: [{ type: "command", command, timeout: 10 }] }];
  return { hooks: { PreToolUse: hook, PostToolUse: hook } };
}

function main() {
  const [name, stateFile, mode] = process.argv.slice(2);
  const lookOnly = mode === "look";
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
          const state = cleanState(readState(stateFile));
          if (onMoneyPage({ tool, response: event.tool_response, tab: state.tab })) return true;
          // The tab this job opened becomes the only tab it may work in.
          if (state.tab == null && tool === PREFIX + "tabs_create_mcp") state.tab = createdTab(event.tool_response);
          writeState(stateFile, afterStep({ tool, input: event.tool_input || {}, response: event.tool_response, name, state }));
          return false;
        });
        if (stop) process.stdout.write(JSON.stringify({ continue: false, stopReason: "Stopped: the browser reached a page where money moves. Nothing is bought in this job." }));
        return process.exit(0);
      }
      if (event.hook_event_name !== "PreToolUse") throw new Error("unknown event");
      const verdict = withLock(stateFile, () => {
        const checked = checkStep({ tool, input: event.tool_input || {}, name, state: readState(stateFile), lookOnly });
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

module.exports = { checkStep, afterStep, changeableRefs, clickableRefs: changeableRefs, cleanState, tabAddress, onMoneyPage, createdTab, isJobPage, guardSettings, NAMESERVERS, MAX_STEPS };
