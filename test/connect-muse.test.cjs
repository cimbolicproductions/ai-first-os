"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { createRelay, createPostgrestStore, sha256Hex } = require("../lib/relay-core.cjs");
const { createFileStore, createRelayServer } = require("../lib/relay-host.cjs");
const { createCloudLink } = require("../lib/cloud-link.cjs");
const { createMuseConnection } = require("../lib/muse-connect.cjs");
const { updateRelay } = require("../lib/backend-provision.cjs");
const { buildWorkOrderPrompt } = require("../lib/os-runtime.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");
const { saveManifest, loadManifest } = require("../lib/workspace.cjs");

const PUBLIC_RELAY = "https://relay.test/functions/v1/aios";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-muse-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t) {
  const dir = tempDir(t);
  const relayFile = path.join(dir, "relay.json");
  const relay = createRelay({
    store: createFileStore({ file: relayFile }),
    phoneTokenHash: await sha256Hex("phone-token"),
    homeTokenHash: await sha256Hex("home-token"),
  });
  const server = createRelayServer({ relay });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  // The app only ever talks to an https relay; in tests that address is routed to the local one.
  const fetchFn = (url, init) => fetch(String(url).replace(PUBLIC_RELAY, base), init);

  const board = createLocalBoard({ boardDir: path.join(dir, "board"), routerName: "Muse" });
  board.initBoard([], { empty: true });
  const notices = createNoticeBook({ dir: path.join(dir, "board") });
  const manifest = {
    roles: { orchestrator: "muse", builder: "claude", auditor: "codex", researcher: "antigravity" },
    backend: { kind: "supabase", ref: "abcdefgh12", url: "https://abcdefgh12.supabase.co", relayUrl: PUBLIC_RELAY },
  };
  const saved = [];
  const secrets = { AIOS_HOME_TOKEN: "home-token" };
  const muse = createMuseConnection({ readSecret: name => secrets[name] || null, saveManifest: m => saved.push(structuredClone(m)), fetchFn });
  const link = createCloudLink({ relayUrl: base, homeToken: "home-token", board, notices, manifest, getAvailability: () => ({}) });

  const call = async (method, route, token, body) => {
    const res = await fetch(`${base}/v1/${route}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(body && method !== "GET" ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  return { dir, relayFile, base, board, manifest, saved, muse, link, call };
}

test("Connect Muse makes a key once, sends only its hash, and Muse's request lands on the board once", async t => {
  const { relayFile, board, manifest, saved, muse, link, call } = await setup(t);

  const connected = await muse.connect(manifest);
  assert.equal(connected.ok, true);
  assert.match(connected.sentence, /https:\/\/relay\.test\/functions\/v1\/aios\/v1\/museapi/);
  assert.match(connected.sentence, /bearer token/);
  assert.ok(manifest.connectors.muse.since);
  assert.equal(saved.length, 1);
  const stored = fs.readFileSync(relayFile, "utf8");
  assert.equal(stored.includes(connected.key), false, "the key itself never reaches the relay");
  assert.ok(stored.includes(await sha256Hex(connected.key)));

  // Muse reads the description with no key; it holds no secret.
  const doc = await call("GET", "museapi");
  assert.equal(doc.status, 200);
  assert.equal(doc.body.servers[0].url, `${PUBLIC_RELAY}/v1`);
  assert.deepEqual(Object.keys(doc.body.paths), ["/requests", "/status"]);
  assert.equal(JSON.stringify(doc.body).includes(await sha256Hex(connected.key)), false);

  // Muse retries the same request many times at once: one is saved.
  const body = { text: "Build me a site that books washer rentals", idempotency_key: randomUUID() };
  const sends = await Promise.all(Array.from({ length: 8 }, () => call("POST", "requests", connected.key, body)));
  assert.equal(sends.filter(s => s.status === 201).length, 1);
  assert.deepEqual(new Set(sends.map(s => s.status)), new Set([200, 201]));
  const requestId = sends[0].body.request_id;
  assert.equal(new Set(sends.map(s => s.body.request_id)).size, 1);
  assert.equal((await call("POST", "requests", connected.key, { ...body, text: "Something else" })).status, 409);

  // While the computer has not checked in, Muse hears that it is saved and waiting.
  const waiting = await call("POST", "status", connected.key, { request_id: requestId });
  assert.equal(waiting.body.state, "queued");
  assert.equal(waiting.body.computer_online, false);
  assert.match(waiting.body.message, /offline/);

  assert.equal(await link.tick(), true);
  await link.tick();
  const rows = board.listTasks();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].Task, rows[0].From, rows[0].To], [body.text, "Muse", "muse"]);
  assert.deepEqual([board.getMeta(rows[0].ID).source, board.getMeta(rows[0].ID).sourceRequest], ["muse", requestId]);
  const open = await call("POST", "status", connected.key, { request_id: requestId });
  assert.deepEqual([open.body.state, open.body.task_id, open.body.computer_online], ["open", rows[0].ID, true]);

  // A late retry after adoption is answered from the receipt and makes no second task.
  assert.equal((await call("POST", "requests", connected.key, body)).body.state, "open");
  await link.tick();
  assert.equal(board.listTasks().length, 1);

  // Even if the same message reaches the computer twice (a lost acknowledgment), the board adopts it once.
  const relayStore = createFileStore({ file: relayFile });
  await relayStore.add("musereq", { request_id: requestId, text: body.text });
  await relayStore.add("musereq", { request_id: requestId, text: body.text });
  await link.tick();
  assert.equal(board.listTasks().length, 1);
  assert.equal((await relayStore.list(["musereq"])).length, 0);
});

test("Muse hears when the owner is needed and when it is done, and can reach nothing else", async t => {
  const { board, manifest, muse, link, call } = await setup(t);
  const { key } = await muse.connect(manifest);
  const { body: receipt } = await call("POST", "requests", key, { text: "Plan my week", idempotency_key: randomUUID() });
  await link.tick();
  const [row] = board.listTasks();

  board.updateByColumnName({ taskId: row.ID, columns: { Status: "Waiting on User" },
    meta: { awaitingReply: true, conversation: [{ role: "muse", text: "Which days are you free?" }], displayTitle: "Plan the week" } });
  await link.tick();
  const asking = await call("POST", "status", key, { request_id: receipt.request_id });
  assert.deepEqual([asking.body.state, asking.body.question, asking.body.title], ["needs_you", "Which days are you free?", "Plan the week"]);
  assert.match(asking.body.message, /needs your answer/);

  board.updateByColumnName({ taskId: row.ID, columns: { Status: "Done" }, meta: { awaitingReply: false, answer: "Your week is planned." } });
  await link.tick();
  const done = await call("POST", "status", key, { request_id: receipt.request_id });
  assert.deepEqual([done.body.state, done.body.answer, done.body.question], ["done", "Your week is planned.", undefined]);

  // Muse's key opens only Muse's two routes. Nothing that answers, approves, reads the queue or changes keys.
  for (const [method, route] of [["POST", "answer"], ["GET", "pull"], ["POST", "request"], ["POST", "connector"], ["GET", "status"], ["POST", "agentstatus"], ["POST", "ack"]]) {
    assert.equal((await call(method, route, key, {})).status, 403, `${method} ${route}`);
  }
  // And the phone and home keys cannot pose as Muse.
  assert.equal((await call("POST", "requests", "phone-token", { text: "x", idempotency_key: randomUUID() })).status, 403);
  assert.equal((await call("POST", "requests", "home-token", { text: "x", idempotency_key: randomUUID() })).status, 403);
  assert.equal((await call("POST", "requests", null, { text: "x", idempotency_key: randomUUID() })).status, 401);
  assert.equal((await call("POST", "status", key, { request_id: randomUUID() })).status, 404);
  assert.equal((await call("POST", "requests", key, { text: "x", idempotency_key: "not-a-uuid" })).status, 400);
});

test("a new key replaces the old one, and turning Muse off stops its key and hides its description", async t => {
  const { manifest, muse, call } = await setup(t);
  const first = await muse.connect(manifest);
  const second = await muse.connect(manifest);
  assert.notEqual(first.key, second.key);
  const send = key => call("POST", "requests", key, { text: "Hello", idempotency_key: randomUUID() });
  assert.equal((await send(first.key)).status, 401);
  assert.equal((await send(second.key)).status, 201);

  assert.deepEqual(await muse.disconnect(manifest), { ok: true });
  assert.equal(manifest.connectors.muse, undefined);
  assert.equal((await send(second.key)).status, 401);
  assert.equal((await call("GET", "museapi")).status, 404);
  assert.deepEqual(muse.status(manifest), { available: true, connected: false, since: null });
});

test("Muse needs the online phone connection, and an older relay gets a one-time code-only update", async t => {
  const secrets = { AIOS_HOME_TOKEN: "home-token" };
  const read = name => secrets[name] || null;
  // No online relay: it says to connect the phone first, before making any key.
  const local = createMuseConnection({ readSecret: read, saveManifest: () => assert.fail("saved"), fetchFn: () => assert.fail("network") });
  assert.equal((await local.connect({ backend: { kind: "local", port: 8787 } })).code, "PHONE_NEEDED");
  assert.equal((await local.connect({})).code, "PHONE_NEEDED");

  // An older relay answers 403 to the new route: the owner is asked to update it once.
  const calls = [];
  let relayKnowsMuse = false;
  const fetchFn = async (url, init) => {
    calls.push(String(url));
    return new Response(JSON.stringify(relayKnowsMuse ? { ok: true } : { ok: false, code: "FORBIDDEN" }), { status: relayKnowsMuse ? 200 : 403 });
  };
  const updates = [];
  const old = createMuseConnection({ readSecret: read, saveManifest: () => {}, fetchFn,
    update: async args => { updates.push(args.ref); relayKnowsMuse = true; return { ok: true }; } });
  const manifest = { backend: { kind: "supabase", ref: "abcdefgh12", relayUrl: PUBLIC_RELAY } };
  assert.equal((await old.connect(manifest)).code, "RELAY_UPDATE_NEEDED");
  assert.equal(manifest.connectors, undefined);
  const after = await old.connect(manifest, { updateFirst: true });
  assert.equal(after.ok, true);
  assert.deepEqual(updates, ["abcdefgh12"]);

  // The update itself: one deploy of the relay code, with Muse's routes. No new tokens, no new project.
  const management = [];
  const result = await updateRelay({
    product: null, ref: "abcdefgh12", env: { AIOS_SUPABASE_ACCESS_TOKEN: "sbp_test" }, api: "https://api.supabase.test",
    fetchFn: async (url, init) => {
      management.push({ url: String(url), method: init.method, file: init.body instanceof FormData ? await init.body.get("file").text() : null });
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(management.map(m => [m.method, m.url]), [["POST", "https://api.supabase.test/v1/projects/abcdefgh12/functions/deploy?slug=aios"]]);
  assert.match(management[0].file, /"GET museapi"/);
  assert.equal((await updateRelay({ ref: "../etc", env: {} })).code, "NO_BACKEND");
});

test("in the online store, only one of several racing claims can win", async t => {
  const table = new Map();
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === "POST") {
      seen.push(init.headers.prefer);
      const row = JSON.parse(init.body);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
      if (table.has(row.key)) return new Response("[]", { status: 201 });
      table.set(row.key, row.value);
      return new Response(JSON.stringify([{ key: row.key, value: row.value }]), { status: 201 });
    }
    const key = decodeURIComponent(u.searchParams.get("key").replace(/^eq\./, ""));
    return new Response(JSON.stringify(table.has(key) ? [{ value: table.get(key) }] : []), { status: 200 });
  };
  const store = createPostgrestStore({ url: "https://abcdefgh12.supabase.co", serviceKey: "service", fetchFn });
  const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => store.claimState("agentreq:x", { n: i })));
  assert.equal(claims.filter(c => c.created).length, 1);
  const winner = claims.find(c => c.created).value;
  for (const claim of claims) assert.deepEqual(claim.value, winner);
  assert.ok(seen.every(p => /resolution=ignore-duplicates/.test(p) && /return=representation/.test(p)));
});

test("the organizer is told a Muse request is not approval, and the connection survives a restart", async t => {
  const prompt = buildWorkOrderPrompt({ ID: "P1", Task: "Pay the invoice", To: "muse" }, {}, { source: "muse" });
  assert.match(prompt, /sent by the owner's Muse assistant/);
  assert.match(prompt, /never approval for a gated action/);

  const dir = tempDir(t);
  saveManifest(dir, { roles: { orchestrator: "muse" }, connectors: { muse: { since: "2026-11-15T15:00:00.000Z" } } });
  assert.deepEqual(loadManifest(dir).connectors, { muse: { since: "2026-11-15T15:00:00.000Z" } });
});

test("the desktop's Connect Muse button only works from the app's own page", async t => {
  const dir = tempDir(t);
  const board = createLocalBoard({ boardDir: path.join(dir, "board") });
  board.initBoard([], { empty: true });
  const calls = [];
  const muse = {
    status: () => ({ available: true, connected: false, since: null }),
    connect: async (m, options) => { calls.push(["connect", options]); return { ok: true, key: "k", sentence: "s" }; },
    disconnect: async () => { calls.push(["disconnect"]); return { ok: true }; },
  };
  const server = createDesktopServer({ workspaceRoot: dir, manifest: { roles: {} }, board, detect: () => [], muse });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, origin = base) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

  assert.deepEqual(await (await fetch(base + "/api/muse")).json(), { available: true, connected: false, since: null });
  assert.equal((await post("/api/muse/connect", {}, "https://evil.example")).status, 403);
  assert.deepEqual(calls, []);
  assert.deepEqual(await (await post("/api/muse/connect", { update: true })).json(), { ok: true, key: "k", sentence: "s" });
  assert.deepEqual(await (await post("/api/muse/disconnect", {})).json(), { ok: true });
  assert.deepEqual(calls, [["connect", { updateFirst: true }], ["disconnect"]]);
});
