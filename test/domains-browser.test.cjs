"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNoticeBook } = require("../lib/notices.cjs");
const { domainStep, readAgentResult, findBrowserAgent } = require("../lib/domains.cjs");
const { HARNESSES } = require("../lib/harness-registry.cjs");

/** The public registry record, with nameservers the test controls. Nothing real is reached. */
function fakeRegistry(nameservers = {}) {
  const calls = [];
  const fetchFn = async url => {
    calls.push(String(url));
    if (url === "https://api.ipify.org") return new Response("203.0.113.7");
    if (url === "https://data.iana.org/rdap/dns.json") return new Response(JSON.stringify({ services: [[["co", "com"], ["https://rdap.example/"]]] }));
    const name = String(url).replace("https://rdap.example/domain/", "");
    if (nameservers[name]) return new Response(JSON.stringify({ nameservers: nameservers[name].map(ldhName => ({ ldhName })) }));
    return new Response("{}", { status: 404 });
  };
  return { fetchFn, calls };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-browser-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notices = createNoticeBook({ dir });
  // The owner turned on letting an agent change nameservers in their Chrome. It is off by default.
  const manifest = { settings: { domains: { agentPoints: "yes" } }, projects: [{ name: "bakery-site", path: path.join(dir, "bakery-site"), createdByOs: true, online: "yes" }] };
  const tools = [];
  const run = async (tool, args) => { tools.push(`${tool} ${args.join(" ")}`); return { code: 0, stdout: "", stderr: "" }; };
  return { notices, manifest, project: manifest.projects[0], tools, run };
}

const agent = { id: "claude", label: "Claude Code", path: "/bin/claude", browser: { tools: ["mcp__claude-in-chrome__navigate", "mcp__claude-in-chrome__find"], needs: "Chrome open with the Claude extension", guarded: true, args: () => [] } };
const bought = { type: "domain", step: "bought", project: "bakery-site", row: "P1", name: "bakerysite.co" };

test("without Namecheap's API, an agent changes the nameservers in the owner's own Chrome, and the registry decides", async t => {
  const { notices, manifest, project, tools, run } = setup(t);
  const nameservers = {};
  const registry = fakeRegistry(nameservers);
  const jobs = [];
  const deps = {
    fetchFn: registry.fetchFn, readSecret: () => null, storeSecret: () => assert.fail("nothing is stored"), run, pollMs: 1, verifyMs: 60000, sleep: async () => {},
    browserAgent: () => agent,
    browserRun: async ({ agent: who, prompt, cwd }) => {
      jobs.push({ who: who.id, prompt, cwd });
      // Namecheap took the change, so the registry now lists Vercel's nameservers.
      nameservers["bakerysite.co"] = ["NS1.VERCEL-DNS.COM", "NS2.VERCEL-DNS.COM."];
      return { code: 0, stdout: 'Saved the custom nameservers.\nAIOS-RESULT: {"status":"done"}' };
    },
  };
  assert.deepEqual(await domainStep({ then: bought, value: "bought", notices, manifest, deps }), { ok: true, name: "bakerysite.co" });

  // One plain line while it works, then the result. Nothing to type, no form.
  const texts = notices.listOpen().map(n => n.text);
  assert.ok(texts.includes("Claude Code is pointing bakerysite.co at bakery-site in your Chrome, where you are signed in to Namecheap. Nothing for you to do."));
  assert.ok(texts.includes("bakerysite.co now points at bakery-site. It can take up to an hour to start working everywhere."));
  assert.equal(notices.listOpen().some(n => n.form === "namecheap"), false);
  assert.deepEqual(tools, ["vercel domains add bakerysite.co bakery-site", "vercel domains add www.bakerysite.co bakery-site"]);
  assert.deepEqual(project.domain, { name: "bakerysite.co", state: "pointed" });

  // The work order is fixed text around the checked name, with the limits spelled out.
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].cwd, project.path);
  const order = jobs[0].prompt;
  assert.ok(order.includes("https://ap.www.namecheap.com/domains/domaincontrolpanel/bakerysite.co/domain"));
  assert.ok(order.includes("ns1.vercel-dns.com and ns2.vercel-dns.com"));
  assert.ok(order.includes("Never type a password, a sign-in code or any payment detail"));
  assert.ok(order.includes("no purchase, renewal or add-on"));
  assert.ok(order.includes('ToolSearch with "select:mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__find"'));
});

test("the agent's word is never enough: an unchanged record, no browser, or no sign-in each end in one plain card", async t => {
  const cases = [
    { said: "done", expect: "Claude Code finished, but Namecheap's record for bakerysite.co still shows other nameservers." },
    { said: "no_browser", expect: "Claude Code could not reach your Chrome to point bakerysite.co at bakery-site. It needs Chrome open with the Claude extension. Then choose Try again." },
    { said: "not_signed_in", expect: "Chrome is not signed in to Namecheap, so Claude Code stopped before changing anything." },
  ];
  for (const { said, expect } of cases) {
    const { notices, manifest, project, tools, run } = setup(t);
    const registry = fakeRegistry({ "bakerysite.co": ["dns1.registrar-servers.com", "dns2.registrar-servers.com"] });
    const deps = { fetchFn: registry.fetchFn, readSecret: () => null, run, pollMs: 1, verifyMs: 0, sleep: async () => {}, browserAgent: () => agent,
      browserRun: async () => ({ code: 0, stdout: `AIOS-RESULT: {"status":"${said}"}` }) };
    const result = await domainStep({ then: bought, value: "bought", notices, manifest, deps });
    assert.equal(result.ok, false, said);
    const card = notices.listOpen().find(n => n.form === "namecheap");
    assert.ok(card.text.startsWith(expect), card.text);
    assert.deepEqual(card.choices.map(c => c.value), ["retry", "manual"]);
    assert.deepEqual(tools, [], "Vercel is not touched until the registry shows the change");
    assert.equal(project.domain, undefined);
  }
});

test("Try again on that card runs the browser job again", async t => {
  const { notices, manifest, run } = setup(t);
  const nameservers = {};
  let runs = 0;
  const deps = { fetchFn: fakeRegistry(nameservers).fetchFn, readSecret: () => null, run, pollMs: 1, verifyMs: 0, sleep: async () => {}, browserAgent: () => agent,
    browserRun: async () => {
      runs++;
      if (runs === 2) nameservers["bakerysite.co"] = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"];
      return { code: 0, stdout: runs === 1 ? 'AIOS-RESULT: {"status":"no_browser"}' : 'AIOS-RESULT: {"status":"done"}' };
    } };
  await domainStep({ then: bought, value: "bought", notices, manifest, deps });
  const card = notices.listOpen().find(n => n.form === "namecheap");
  const again = await domainStep({ then: card.then, value: "retry", notices, manifest, deps });
  assert.equal(runs, 2);
  assert.deepEqual(again, { ok: true, name: "bakerysite.co" });
});

test("browser jobs get browser tools only, never run during a test, and the job text never rides on the command line", async () => {
  assert.deepEqual(HARNESSES.filter(h => h.browser).map(h => h.id), ["claude", "codex"]);
  const args = HARNESSES.find(h => h.id === "claude").browser.args();
  assert.ok(args.includes("--chrome"));
  const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
  assert.ok(allowed.every(tool => tool === "ToolSearch" || tool.startsWith("mcp__claude-in-chrome__")));
  assert.equal(allowed.includes("mcp__claude-in-chrome__javascript_tool"), false);
  assert.match(args[args.indexOf("--disallowedTools") + 1], /\bBash\b.*\bWrite\b/);
  assert.equal(args.some(a => /bakerysite|namecheap/i.test(a)), false);

  assert.equal(readAgentResult('All set.\nAIOS-RESULT: {"status":"done"}'), "done");
  assert.equal(readAgentResult('AIOS-RESULT: {"status":"rm -rf"}'), "unknown");
  assert.equal(readAgentResult("no line at all"), "unknown");

  // Under the test runner the real agent is never found, even with Claude signed in here.
  assert.equal(findBrowserAgent({ detect: () => [{ id: "claude", signedIn: true, workerPath: "/bin/claude" }] }), null);
  assert.equal(findBrowserAgent({ env: {}, detect: () => [{ id: "claude", signedIn: true, workerPath: "/bin/claude" }] }).label, "Claude Code");
  assert.equal(findBrowserAgent({ env: {}, detect: () => [{ id: "claude", signedIn: false, workerPath: "/bin/claude" }] }), null);
});
