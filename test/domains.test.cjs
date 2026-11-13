"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNoticeBook } = require("../lib/notices.cjs");
const { answerNotice } = require("../lib/os-runtime.cjs");
const { candidates, findNames, domainStep, connectNamecheap, offerDomain, KEY_SECRET } = require("../lib/domains.cjs");

const ok = inner => `<?xml version="1.0" encoding="utf-8"?><ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="OK"><Errors/><CommandResponse>${inner}</CommandResponse></ApiResponse>`;
const refused = (number, message) => `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="ERROR"><Errors><Error Number="${number}">${message}</Error></Errors></ApiResponse>`;

/**
 * A stand-in internet: this computer's address, the public registry record, and
 * Namecheap's API. Every call is recorded. Nothing real is reached.
 */
function fakeNet({ taken = [], owned = [], premium = [], prices = { COM: "10.98", CO: "8.50", APP: "14.98" }, refuse = null } = {}) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const body = options.body ? Object.fromEntries(new URLSearchParams(String(options.body))) : null;
    calls.push({ url: String(url), method: options.method || "GET", body });
    if (url === "https://api.ipify.org") return new Response("203.0.113.7");
    if (url === "https://data.iana.org/rdap/dns.json") return new Response(JSON.stringify({ services: [[["com", "co", "app", "dev"], ["https://rdap.example/"]]] }));
    if (String(url).startsWith("https://rdap.example/domain/")) {
      const name = String(url).slice("https://rdap.example/domain/".length);
      return new Response("{}", { status: taken.includes(name) || owned.includes(name) ? 200 : 404 });
    }
    if (url === "https://api.namecheap.com/xml.response") {
      if (refuse) return new Response(refused(...refuse));
      if (body.Command === "namecheap.domains.check") {
        return new Response(ok(body.DomainList.split(",").map(name =>
          `<DomainCheckResult Domain="${name}" Available="${!taken.includes(name) && !owned.includes(name)}" IsPremiumName="${premium.includes(name)}" PremiumRegistrationPrice="${premium.includes(name) ? "4800.0000" : "0"}" IcannFee="${name.endsWith(".com") ? "0.20" : "0"}"/>`).join("")));
      }
      if (body.Command === "namecheap.users.getPricing") {
        return new Response(ok(`<UserGetPricingResult><ProductType Name="DOMAIN"><ProductCategory Name="REGISTER"><Product Name="${body.ProductName.toLowerCase()}"><Price Duration="1" DurationType="YEAR" Price="${prices[body.ProductName]}" RegularPrice="${prices[body.ProductName]}" YourPrice="${prices[body.ProductName]}" Currency="USD"/><Price Duration="2" DurationType="YEAR" Price="99" YourPrice="99" Currency="USD"/></Product></ProductCategory></ProductType></UserGetPricingResult>`));
      }
      if (body.Command === "namecheap.domains.getList") return new Response(ok(`<DomainGetListResult>${owned.map(name => `<Domain ID="1" Name="${name}" IsOurDNS="true"/>`).join("")}</DomainGetListResult>`));
      if (body.Command === "namecheap.domains.dns.setCustom") return new Response(ok(`<DomainDNSSetCustomResult Domain="${body.SLD}.${body.TLD}" Updated="true"/>`));
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, calls, namecheapCalls: () => calls.filter(c => c.url.includes("namecheap")) };
}

function fakeKeyring(start = {}) {
  const stored = { ...start };
  return { stored, readSecret: name => stored[name] || null, storeSecret: (name, value) => { stored[name] = value; } };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-domain-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notices = createNoticeBook({ dir });
  const manifest = { settings: {}, projects: [{ name: "bakery-site", path: path.join(dir, "bakery-site"), createdByOs: true, online: "yes" }] };
  const tools = [];
  const run = async (tool, args, options) => { tools.push({ line: `${tool} ${args.join(" ")}`, cwd: options?.cwd }); return { code: 0, stdout: "", stderr: "" }; };
  return { dir, notices, manifest, project: manifest.projects[0], tools, run };
}

test("names come from the project's own name, and only letters and digits ever reach a command", () => {
  assert.deepEqual(candidates("bakery-site").slice(0, 4), ["bakerysite.com", "getbakerysite.com", "bakerysite.co", "bakerysite.app"]);
  assert.deepEqual(candidates("a"), []);
  for (const name of candidates("../x; rm -rf / & echo")) assert.match(name, /^[a-z0-9]+\.[a-z]+$/);
});

test("with Namecheap connected: free names with first-year prices, premium and pricey ones left out", async () => {
  const net = fakeNet({ taken: ["bakerysite.com"], premium: ["getbakerysite.com"] });
  const namecheap = require("../lib/domains.cjs").namecheapClient({ user: "owner", apiKey: "k".repeat(32), clientIp: "203.0.113.7", fetchFn: net.fetchFn });
  const found = await findNames({ project: "bakery-site", namecheap });
  assert.deepEqual(found, [{ name: "bakerysite.co", price: 8.5 }, { name: "bakerysite.app", price: 14.98 }, { name: "trybakerysite.com", price: 11.18 }]);
  // The key travels in the request body, never in an address that could be logged.
  for (const call of net.namecheapCalls()) {
    assert.equal(call.method, "POST");
    assert.doesNotMatch(call.url, /ApiKey|kkkk/);
    assert.equal(call.body.ApiKey, "k".repeat(32));
    assert.equal(call.body.ClientIp, "203.0.113.7");
  }
});

test("without Namecheap: the public registry record says which names are free, and Namecheap shows the price", async () => {
  const net = fakeNet({ taken: ["bakerysite.com", "getbakerysite.com"] });
  const found = await findNames({ project: "bakery-site", fetchFn: net.fetchFn });
  assert.deepEqual(found, [{ name: "bakerysite.co", price: null }, { name: "bakerysite.app", price: null }, { name: "trybakerysite.com", price: null }]);
  assert.equal(net.namecheapCalls().length, 0);
});

test("find, pick, buy on Namecheap's page, connect once, and the name points at the site by itself", async t => {
  const { notices, manifest, project, tools, run } = setup(t);
  const owned = [];
  const net = fakeNet({ taken: ["bakerysite.com"], owned });
  const keyring = fakeKeyring();
  const opened = [];
  let polls = 0;
  // The owner pays on Namecheap between the app's second and third check.
  const sleep = async () => { polls++; if (polls === 2) owned.push("bakerysite.co"); await new Promise(r => setImmediate(r)); };
  const deps = { fetchFn: net.fetchFn, readSecret: keyring.readSecret, storeSecret: keyring.storeSecret, run, openUrl: url => opened.push(url), pollMs: 1, watchMs: 60000, sleep, browserAgent: () => null };

  // Asked once, after the site first goes online.
  const offer = offerDomain({ project, row: "P1", liveUrl: "https://bakery-site.vercel.app", notices, manifest });
  assert.equal(offerDomain({ project, row: "P1", liveUrl: "https://bakery-site.vercel.app", notices, manifest }), null, "never asked twice");

  // Find a name: three free ones, Not now always there.
  await answerNotice({ noticeId: offer.id, value: "find", notices, board: null, manifest, source: "computer", domainDeps: deps }).domain;
  const pick = notices.listOpen().find(n => n.then?.step === "pick");
  assert.deepEqual(pick.choices.map(c => c.label), ["getbakerysite.com", "bakerysite.co", "bakerysite.app", "Not now"]);
  assert.match(pick.text, /Picking one opens Namecheap, which shows the price and the renewal price before you pay\./);

  // Picking one opens Namecheap's own checkout. Nothing is bought here.
  const picked = await answerNotice({ noticeId: pick.id, value: "name:bakerysite.co", notices, board: null, manifest, source: "computer", domainDeps: deps }).domain;
  assert.deepEqual(opened, ["https://www.namecheap.com/domains/registration/results/?domain=bakerysite.co"]);
  const wait = notices.listOpen().find(n => n.then?.step === "bought");
  assert.equal(wait.link, opened[0]);
  assert.equal(wait.linkLabel, "Open Namecheap");
  assert.match(wait.text, /You pay there\. Once it is yours, this carries on by itself and points it at your site\./);
  assert.deepEqual(project.domain, { name: "bakerysite.co", state: "buying" });

  // The owner pays on Namecheap. The public registry record changes, and the app notices on its own.
  const watched = await picked.watching;
  assert.equal(net.calls.filter(c => c.url === "https://rdap.example/domain/bakerysite.co").length, 4, "one while finding names, two before the purchase, one after");

  // Namecheap is not connected yet: one form on the computer, with this computer's address to allow.
  const form = notices.listOpen().find(n => n.form === "namecheap");
  assert.ok(watched.asked && form);
  assert.equal(notices.listOpen().some(n => n.then?.step === "bought"), false, "the buy prompt is closed");
  assert.match(form.text, /bakerysite\.co is yours\. .*allow this computer's address 203\.0\.113\.7, then paste your Namecheap username and API key here\./);
  assert.equal(form.link, "https://ap.www.namecheap.com/settings/tools/apiaccess/");
  assert.deepEqual(form.choices, [{ label: "Do it by hand instead", value: "manual" }]);

  // A key Namecheap refuses is never kept.
  const refusing = fakeNet({ refuse: ["1011150", "Invalid request IP: 203.0.113.7"] });
  const wrongIp = await connectNamecheap({ noticeId: form.id, user: "owner", apiKey: "a1".repeat(16), notices, manifest, deps: { ...deps, fetchFn: refusing.fetchFn } });
  assert.equal(wrongIp.ok, false);
  assert.match(wrongIp.message, /Add 203\.0\.113\.7 on the API page/);
  assert.deepEqual(keyring.stored, {});
  const badKey = await connectNamecheap({ noticeId: form.id, user: "owner", apiKey: "a1".repeat(16), notices, manifest, deps: { ...deps, fetchFn: fakeNet({ refuse: ["1011102", "API Key is invalid or API access has not been enabled"] }).fetchFn } });
  assert.match(badKey.message, /20 or more domains, a \$50 balance, or \$50 spent in the last two years/);
  assert.deepEqual(keyring.stored, {});

  // A good one is checked with Namecheap, kept in the keyring only, and the name is pointed at the site.
  const good = await connectNamecheap({ noticeId: form.id, user: "owner", apiKey: "a1".repeat(16), notices, manifest, deps });
  assert.equal(good.ok, true);
  await good.pointing;
  assert.deepEqual(keyring.stored, { [KEY_SECRET]: "a1".repeat(16) });
  assert.equal(manifest.settings.namecheap.user, "owner");
  assert.doesNotMatch(JSON.stringify(manifest), /a1a1a1/, "the key is never written to the workspace file");
  const setCustom = net.calls.find(c => c.body?.Command === "namecheap.domains.dns.setCustom");
  assert.deepEqual({ SLD: setCustom.body.SLD, TLD: setCustom.body.TLD, Nameservers: setCustom.body.Nameservers }, { SLD: "bakerysite", TLD: "co", Nameservers: "ns1.vercel-dns.com,ns2.vercel-dns.com" });
  assert.deepEqual(tools.map(x => x.line), ["vercel domains add bakerysite.co bakery-site", "vercel domains add www.bakerysite.co bakery-site"]);
  assert.ok(tools.every(x => x.cwd === project.path));
  assert.deepEqual(project.domain, { name: "bakerysite.co", state: "pointed" });
  assert.ok(notices.listOpen().some(n => n.text === "bakerysite.co now points at bakery-site. It can take up to an hour to start working everywhere."));
  assert.equal(notices.listOpen().some(n => n.form === "namecheap"), false);
});

test("once Namecheap is connected, a bought name is pointed with no questions, and only once", async t => {
  const { notices, manifest, project, tools, run } = setup(t);
  manifest.settings.namecheap = { user: "owner" };
  const keyring = fakeKeyring({ [KEY_SECRET]: "b2".repeat(16) });
  const net = fakeNet({ owned: ["bakerysite.co"] });
  const deps = { fetchFn: net.fetchFn, readSecret: keyring.readSecret, storeSecret: keyring.storeSecret, run, openUrl: () => {}, pollMs: 1, watchMs: 60000, sleep: async () => {}, browserAgent: () => assert.fail("the API needs no browser") };
  project.domain = { name: "bakerysite.co", state: "buying" };
  const then = { type: "domain", step: "bought", project: "bakery-site", row: "P1", name: "bakerysite.co" };
  const [a, b] = await Promise.all([domainStep({ then, value: "bought", notices, manifest, deps }), domainStep({ then, value: "bought", notices, manifest, deps })]);
  assert.deepEqual(a, b);
  assert.equal(net.calls.filter(c => c.body?.Command === "namecheap.domains.dns.setCustom").length, 1);
  assert.equal(tools.filter(x => x.line === "vercel domains add bakerysite.co bakery-site").length, 1);
  assert.equal(notices.listOpen().some(n => n.form === "namecheap"), false);
});

test("doing it by hand gives the two nameservers and the page to set them on", async t => {
  const { notices, manifest, project, tools, run } = setup(t);
  const then = { type: "domain", step: "dns", project: "bakery-site", row: "P1", name: "bakerysite.co" };
  await domainStep({ then, value: "manual", notices, manifest, deps: { run } });
  const steps = notices.listOpen().find(n => n.then?.step === "manual-done");
  assert.match(steps.text, /set Nameservers to Custom DNS, and enter ns1\.vercel-dns\.com and ns2\.vercel-dns\.com/);
  assert.equal(steps.link, "https://ap.www.namecheap.com/domains/list/");
  assert.deepEqual(tools.map(x => x.line), ["vercel domains add bakerysite.co bakery-site"]);
  // Done is only believed once the public record shows the change.
  const record = async url => {
    if (url === "https://data.iana.org/rdap/dns.json") return new Response(JSON.stringify({ services: [[["co"], ["https://rdap.example/"]]] }));
    return new Response(JSON.stringify({ nameservers: [{ ldhName: "ns1.vercel-dns.com" }, { ldhName: "ns2.vercel-dns.com" }] }));
  };
  await domainStep({ then: steps.then, value: "done", notices, manifest, deps: { run, fetchFn: record } });
  assert.deepEqual(project.domain, { name: "bakerysite.co", state: "pointed" });
});

test("a name that was not offered can never be bought or pointed", async t => {
  const { notices, manifest } = setup(t);
  const then = { type: "domain", step: "pick", project: "bakery-site", row: "P1", names: ["bakerysite.co"] };
  const opened = [];
  for (const value of ["name:evil.com", "name:bakerysite.co & calc", "name:../x"]) {
    assert.equal((await domainStep({ then, value, notices, manifest, deps: { openUrl: url => opened.push(url) } })).ok, false);
  }
  assert.deepEqual(opened, []);
  const declined = await domainStep({ then, value: "no", notices, manifest, deps: {} });
  assert.equal(declined.declined, true);
  assert.equal(manifest.projects[0].domain, "no");
});
