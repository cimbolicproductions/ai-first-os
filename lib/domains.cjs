"use strict";

const { spawn } = require("node:child_process");
const { getSetting, setSetting } = require("./workspace.cjs");

/**
 * A web address of the owner's own. Free names are found first, with first-year
 * prices when Namecheap is connected. The owner picks one and pays on Namecheap's
 * own page: nothing here ever buys anything. Once the name is theirs it is pointed
 * at their site through Namecheap's API, not a dashboard.
 */
const NAMECHEAP_API = "https://api.namecheap.com/xml.response";
const API_PAGE = "https://ap.www.namecheap.com/settings/tools/apiaccess/";
const DOMAIN_LIST_PAGE = "https://ap.www.namecheap.com/domains/list/";
const VERCEL_NAMESERVERS = Object.freeze(["ns1.vercel-dns.com", "ns2.vercel-dns.com"]);
const KEY_SECRET = "AIOS_NAMECHEAP_KEY";
const USER_SETTING = "settings.namecheap.user";
const MAX_FIRST_YEAR = 40;
const RDAP_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

const buyPage = name => `https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(name)}`;
const validName = name => typeof name === "string" && name.length <= 80 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,24})+$/.test(name);

/** Names close to the project's own, best first. Letters and digits only, so nothing odd reaches a command. */
function candidates(projectName) {
  const base = String(projectName || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  if (base.length < 2) return [];
  return [...new Set([`${base}.com`, `get${base}.com`, `${base}.co`, `${base}.app`, `try${base}.com`, `${base}hq.com`, `${base}.dev`, `${base}app.com`, `the${base}.com`])].filter(validName);
}

const attributes = tag => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const elements = (xml, name) => [...String(xml).matchAll(new RegExp(`<${name}\\b([^>]*?)\\/?>`, "g"))].map(m => attributes(m[1]));

/** Sorts a Namecheap refusal into what the owner can do about it. */
function classify(number, message) {
  const text = String(message || "");
  if (/\bIP\b/i.test(text) || number === "1011150") return "IP_NOT_ALLOWED";
  if (/api ?key|api access|ApiUser|UserName/i.test(text) || number === "1011102") return "KEY_REJECTED";
  return "NAMECHEAP_FAILED";
}

/** Calls Namecheap with the key in the request body, never in an address. */
function namecheapClient({ user, apiKey, clientIp, fetchFn = fetch, api = NAMECHEAP_API }) {
  return async function call(command, params = {}) {
    const body = new URLSearchParams({ ApiUser: user, ApiKey: apiKey, UserName: user, ClientIp: clientIp, Command: command, ...params });
    let res;
    try {
      res = await fetchFn(api, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20000) });
    } catch {
      throw Object.assign(new Error("Namecheap did not answer."), { code: "NAMECHEAP_UNREACHABLE" });
    }
    const xml = await res.text();
    if (/<ApiResponse\b[^>]*\bStatus="OK"/i.test(xml)) return xml;
    const error = /<Error\b([^>]*)>([^<]*)<\/Error>/i.exec(xml);
    const number = error ? attributes(error[1]).Number || null : null;
    throw Object.assign(new Error(error?.[2]?.trim() || `Namecheap answered ${res.status}.`), { code: classify(number, error?.[2]), number });
  };
}

/** This computer's internet address, which Namecheap must allow. Namecheap only takes IPv4. */
async function publicIp(fetchFn = fetch) {
  try {
    const res = await fetchFn("https://api.ipify.org", { signal: AbortSignal.timeout(8000) });
    const ip = (await res.text()).trim();
    return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** The stored connection, or null when Namecheap was never connected. The key stays in the keyring. */
async function storedNamecheap({ manifest, readSecret, fetchFn = fetch }) {
  const user = getSetting(manifest, USER_SETTING);
  if (!user) return null;
  const apiKey = readSecret(KEY_SECRET);
  if (!apiKey) return null;
  const clientIp = await publicIp(fetchFn);
  return clientIp ? namecheapClient({ user, apiKey, clientIp, fetchFn }) : null;
}

const rdapCache = new WeakMap();

/** Whether a name is taken, from the registry's public record. True, false, or null when it cannot tell. */
async function rdapRegistered(name, fetchFn = fetch) {
  let servers = rdapCache.get(fetchFn);
  if (!servers) {
    const res = await fetchFn(RDAP_BOOTSTRAP, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    servers = new Map();
    for (const [tlds, urls] of (await res.json()).services || []) {
      const url = urls.find(u => u.startsWith("https://")) || urls[0];
      for (const tld of tlds) servers.set(tld, url.endsWith("/") ? url : `${url}/`);
    }
    rdapCache.set(fetchFn, servers);
  }
  const base = servers.get(name.split(".").pop());
  if (!base) return null;
  try {
    const res = await fetchFn(`${base}domain/${name}`, { headers: { accept: "application/rdap+json" }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return false;
    return res.ok ? true : null;
  } catch {
    return null;
  }
}

/** The first-year price to register a name ending in this extension, in dollars. */
async function registerPrice(namecheap, tld) {
  const xml = await namecheap("namecheap.users.getPricing", { ProductType: "DOMAIN", ActionName: "REGISTER", ProductName: tld.toUpperCase() });
  const section = /<ProductCategory\b[^>]*Name="REGISTER"[^>]*>([\s\S]*?)<\/ProductCategory>/i.exec(xml)?.[1] || xml;
  const year = elements(section, "Price").find(p => p.Duration === "1" && /^YEAR$/i.test(p.DurationType || ""));
  const price = Number(year?.YourPrice || year?.Price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Up to three free names. With Namecheap connected each has its first-year price,
 * premium names and anything over $40 are left out. Without it, the registry's
 * public record says which are free and Namecheap shows the price at checkout.
 */
async function findNames({ project, namecheap = null, fetchFn = fetch, limit = 3 }) {
  const names = candidates(project);
  if (!names.length) return [];
  if (namecheap) {
    const xml = await namecheap("namecheap.domains.check", { DomainList: names.join(",") });
    const free = elements(xml, "DomainCheckResult")
      .filter(r => r.Available === "true" && r.IsPremiumName !== "true" && validName(String(r.Domain).toLowerCase()))
      .map(r => ({ name: r.Domain.toLowerCase(), icann: Number(r.IcannFee) || 0 }))
      .sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
    const prices = {};
    for (const tld of new Set(free.map(f => f.name.slice(f.name.indexOf(".") + 1)))) prices[tld] = await registerPrice(namecheap, tld).catch(() => null);
    return free
      .map(f => {
        const base = prices[f.name.slice(f.name.indexOf(".") + 1)];
        return { name: f.name, price: base == null ? null : Math.round((base + f.icann) * 100) / 100 };
      })
      .filter(f => f.price === null || f.price <= MAX_FIRST_YEAR)
      .slice(0, limit);
  }
  const found = [];
  for (const name of names) {
    if (found.length >= limit) break;
    if ((await rdapRegistered(name, fetchFn)) === false) found.push({ name, price: null });
  }
  return found;
}

async function ownsDomain(namecheap, name) {
  const xml = await namecheap("namecheap.domains.getList", { SearchTerm: name.split(".")[0], PageSize: "100" });
  return elements(xml, "Domain").some(d => String(d.Name).toLowerCase() === name);
}

function openInBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  const [file, args] = platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawnFn(file, args, { detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function defaultDeps(deps = {}) {
  const keyring = require("./keyring.cjs");
  return {
    fetchFn: fetch,
    readSecret: keyring.readSecret,
    storeSecret: keyring.storeSecret,
    run: require("./ship.cjs").defaultRun,
    openUrl: openInBrowser,
    pollMs: 30000,
    watchMs: 60 * 60000,
    sleep,
    ...deps,
  };
}

/** The question after a project first goes online. Asked once per project. */
function offerDomain({ project, row, liveUrl, notices, manifest, saveManifest = () => {} }) {
  if (project.domain !== undefined || !candidates(project.name).length) return null;
  project.domain = "offered";
  saveManifest(manifest);
  const host = liveUrl ? new URL(liveUrl).host : null;
  return notices.raise({
    row, kind: "question",
    text: `Give ${project.name} its own web address${host ? `, instead of ${host}` : ""}? I find names that are free first. Nothing is bought unless you buy it yourself.`,
    choices: [{ label: "Find a name", value: "find" }, { label: "Not now", value: "no" }],
    then: { type: "domain", step: "offer", project: project.name, row },
  });
}

const inFlight = new Map();

/**
 * Points a name the owner now owns at their site: Namecheap hands the name to
 * Vercel's nameservers, and Vercel attaches it to the project.
 */
async function pointAtSite({ project, name, row, namecheap, notices, manifest, saveManifest, d }) {
  const [sld, ...rest] = name.split(".");
  const retry = { label: "Try again", value: "retry" };
  try {
    await namecheap("namecheap.domains.dns.setCustom", { SLD: sld, TLD: rest.join("."), Nameservers: VERCEL_NAMESERVERS.join(",") });
  } catch (err) {
    notices.raise({ row, kind: "blocked", text: `Namecheap would not point ${name} at your site just now${err.code === "IP_NOT_ALLOWED" ? ", because this computer's internet address changed. Add the new one on Namecheap's API page" : ""}.`, choices: [retry], then: { type: "domain", step: "retry", project: project.name, row, name }, ...(err.code === "IP_NOT_ALLOWED" ? { link: API_PAGE, linkLabel: "Open Namecheap's API page" } : {}) });
    return { ok: false, step: "namecheap", code: err.code };
  }
  const added = await d.run("vercel", ["domains", "add", name, project.name], { cwd: project.path });
  if (added.code !== 0 && !/already/i.test(`${added.stdout}\n${added.stderr}`)) {
    notices.raise({ row, kind: "blocked", text: `${name} now points at Vercel, but Vercel did not attach it to ${project.name} yet.`, choices: [retry], then: { type: "domain", step: "retry", project: project.name, row, name } });
    return { ok: false, step: "vercel" };
  }
  await d.run("vercel", ["domains", "add", `www.${name}`, project.name], { cwd: project.path });
  project.domain = { name, state: "pointed" };
  saveManifest(manifest);
  notices.raise({ row, kind: "done", text: `${name} now points at ${project.name}. It can take up to an hour to start working everywhere.` });
  return { ok: true, name };
}

/** Raises the one thing pointing needs: Namecheap connected once, on the computer. */
async function askForNamecheap({ project, name, row, notices, d }) {
  const ip = await publicIp(d.fetchFn);
  return notices.raise({
    row, kind: "connect", form: "namecheap", link: API_PAGE, linkLabel: "Open Namecheap's API page",
    text: `${name} is yours. To point it at ${project.name}, connect Namecheap once on your computer: open Namecheap's API page, turn API access on${ip ? `, allow this computer's address ${ip}` : ""}, then paste your Namecheap username and API key here.`,
    choices: [{ label: "Do it by hand instead", value: "manual" }],
    then: { type: "domain", step: "dns", project: project.name, row, name },
  });
}

/** Once the name is the owner's: point it, or ask for the one connection that needs. Runs once per name. */
function afterPurchase({ project, name, row, notices, manifest, saveManifest, d }) {
  if (inFlight.has(name)) return inFlight.get(name);
  const job = (async () => {
    for (const open of notices.listOpen()) {
      if (open.then?.type === "domain" && open.then.step === "bought" && open.then.name === name) notices.recordAnswer(open.id, "owned", "computer");
    }
    const namecheap = await storedNamecheap({ manifest, readSecret: d.readSecret, fetchFn: d.fetchFn });
    if (!namecheap) return { ok: true, asked: await askForNamecheap({ project, name, row, notices, d }) };
    return pointAtSite({ project, name, row, namecheap, notices, manifest, saveManifest, d });
  })().finally(() => inFlight.delete(name));
  inFlight.set(name, job);
  return job;
}

/** Checks every half minute whether the name has become the owner's, for up to an hour. */
async function watchForPurchase({ project, name, row, notices, manifest, saveManifest, d }) {
  const stop = Date.now() + d.watchMs;
  while (Date.now() < stop) {
    if (project.domain?.state === "pointed" || inFlight.has(name)) return { ok: true, handled: true };
    const namecheap = await storedNamecheap({ manifest, readSecret: d.readSecret, fetchFn: d.fetchFn }).catch(() => null);
    const owned = namecheap ? await ownsDomain(namecheap, name).catch(() => false) : (await rdapRegistered(name, d.fetchFn)) === true;
    if (owned) return afterPurchase({ project, name, row, notices, manifest, saveManifest, d });
    await d.sleep(d.pollMs);
  }
  return { ok: false, reason: "timeout" };
}

/** Every answer in the domain flow lands here. */
async function domainStep({ then, value, source = "computer", notices, manifest, saveManifest = () => {}, deps = {} }) {
  const d = defaultDeps(deps);
  const project = (manifest.projects || []).find(p => p.name === then.project);
  if (!project) return { ok: false, reason: "no_project" };
  const row = then.row;

  if (then.step === "offer" || then.step === "pick") {
    if (value === "no") {
      project.domain = "no";
      saveManifest(manifest);
      return { ok: true, declined: true };
    }
  }

  if (then.step === "offer") {
    let found;
    const namecheap = await storedNamecheap({ manifest, readSecret: d.readSecret, fetchFn: d.fetchFn }).catch(() => null);
    try {
      found = await findNames({ project: project.name, namecheap, fetchFn: d.fetchFn });
    } catch {
      found = namecheap ? await findNames({ project: project.name, fetchFn: d.fetchFn }).catch(() => []) : [];
    }
    if (!found.length) {
      notices.raise({ row, kind: "done", text: `I could not find a free address close to ${project.name} right now.` });
      return { ok: true, found: [] };
    }
    const priced = found.some(f => f.price !== null);
    notices.raise({
      row, kind: "question",
      text: priced
        ? `Pick an address for ${project.name}. Prices are Namecheap's for the first year, and renewing can cost more. Picking one opens Namecheap's checkout, and you pay there.`
        : `These addresses are free for ${project.name}. Picking one opens Namecheap, which shows the price and the renewal price before you pay.`,
      choices: [...found.map(f => ({ label: f.price !== null ? `${f.name} · $${f.price.toFixed(2)} first year` : f.name, value: `name:${f.name}` })), { label: "Not now", value: "no" }],
      then: { type: "domain", step: "pick", project: project.name, row, names: found.map(f => f.name) },
    });
    return { ok: true, found };
  }

  if (then.step === "pick") {
    const name = String(value).slice("name:".length);
    if (!String(value).startsWith("name:") || !validName(name) || !(then.names || []).includes(name)) return { ok: false, reason: "bad_name" };
    const url = buyPage(name);
    if (source === "computer" || source === "desktop") d.openUrl(url);
    project.domain = { name, state: "buying" };
    saveManifest(manifest);
    notices.raise({
      row, kind: "connect", link: url, linkLabel: "Open Namecheap",
      text: `Finish buying ${name} on Namecheap's page. You pay there. This carries on by itself once it is yours.`,
      choices: [{ label: "I bought it", value: "bought" }],
      then: { type: "domain", step: "bought", project: project.name, row, name },
    });
    const watching = watchForPurchase({ project, name, row, notices, manifest, saveManifest, d }).catch(() => null);
    return { ok: true, opened: url, watching };
  }

  const name = then.name;
  if (!validName(name)) return { ok: false, reason: "bad_name" };

  if (then.step === "bought" || then.step === "retry") return afterPurchase({ project, name, row, notices, manifest, saveManifest, d });

  if (then.step === "dns" && value === "manual") {
    await d.run("vercel", ["domains", "add", name, project.name], { cwd: project.path });
    notices.raise({
      row, kind: "connect", link: DOMAIN_LIST_PAGE, linkLabel: "Open your Namecheap domains",
      text: `In Namecheap, open ${name}, set Nameservers to Custom DNS, and enter ${VERCEL_NAMESERVERS.join(" and ")}. Then choose Done.`,
      choices: [{ label: "Done", value: "done" }],
      then: { type: "domain", step: "manual-done", project: project.name, row, name },
    });
    return { ok: true, manual: true };
  }

  if (then.step === "manual-done") {
    project.domain = { name, state: "pointed" };
    saveManifest(manifest);
    notices.raise({ row, kind: "done", text: `${name} is set up for ${project.name}. It can take up to a day to start working everywhere.` });
    return { ok: true, name };
  }
  return { ok: false, reason: "unknown_step" };
}

/**
 * The owner pasted their Namecheap username and key on the computer. Checked with
 * Namecheap before anything is kept, kept only in the keyring, never shown again.
 */
async function connectNamecheap({ noticeId, user, apiKey, notices, manifest, saveManifest = () => {}, deps = {} }) {
  const d = defaultDeps(deps);
  const notice = notices.get(noticeId);
  if (!notice || notice.answer || notice.form !== "namecheap") return { ok: false, message: "That question is no longer open." };
  const username = String(user || "").trim();
  const key = String(apiKey || "").trim();
  if (!/^[A-Za-z0-9_.-]{2,64}$/.test(username) || !/^[A-Za-z0-9]{16,64}$/.test(key)) return { ok: false, message: "That does not look like a Namecheap username and API key." };
  const ip = await publicIp(d.fetchFn);
  if (!ip) return { ok: false, message: "I could not find this computer's internet address. Check the connection and try again." };
  const namecheap = namecheapClient({ user: username, apiKey: key, clientIp: ip, fetchFn: d.fetchFn });
  try {
    await namecheap("namecheap.domains.getList", { PageSize: "10" });
  } catch (err) {
    return {
      ok: false,
      code: err.code,
      message: err.code === "IP_NOT_ALLOWED"
        ? `Namecheap has not allowed this computer yet. Add ${ip} on the API page, wait a minute, then connect again.`
        : err.code === "KEY_REJECTED"
          ? "Namecheap did not accept that username and key. Check API access is on. Namecheap only turns it on for accounts with 20 or more domains, a $50 balance, or $50 spent in the last two years."
          : "Namecheap did not answer just now. Try again.",
    };
  }
  d.storeSecret(KEY_SECRET, key);
  setSetting(manifest, USER_SETTING, username);
  saveManifest(manifest);
  notices.recordAnswer(noticeId, "connected", "computer");
  notices.raise({ row: notice.row, kind: "done", text: "Connected to Namecheap." });
  const project = (manifest.projects || []).find(p => p.name === notice.then?.project);
  const pointing = project && validName(notice.then?.name)
    ? pointAtSite({ project, name: notice.then.name, row: notice.row, namecheap, notices, manifest, saveManifest, d }).catch(() => null)
    : null;
  return { ok: true, pointing };
}

module.exports = {
  candidates, validName, buyPage, findNames, rdapRegistered, namecheapClient, publicIp, registerPrice,
  offerDomain, domainStep, connectNamecheap, afterPurchase,
  API_PAGE, VERCEL_NAMESERVERS, KEY_SECRET, USER_SETTING,
};
