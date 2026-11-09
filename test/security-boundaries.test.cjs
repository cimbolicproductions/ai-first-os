"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { detectInstalledAgents, locateBinary } = require("../lib/agent-auth.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");
const { findHarness } = require("../lib/harness-registry.cjs");
const { createRelay, sha256Hex } = require("../lib/relay-core.cjs");
const { createVapidKeys, sendEmptyPush } = require("../lib/web-push.cjs");

const supportedPushEndpoints = [
  "https://fcm.googleapis.com/wp/fixture",
  "https://updates.push.services.mozilla.com/wpush/v2/fixture",
  "https://web.push.apple.com/fixture",
  "https://wns2.notify.windows.com/?token=fixture",
];
const rejectedPushEndpoints = [
  "https://127.0.0.1/fixture",
  "https://[::ffff:127.0.0.1]/fixture",
  "https://0x7f000001/fixture",
  "https://169.254.169.254/fixture",
  "http://127.0.0.1/fixture",
  "https://fcm.googleapis.com.attacker.example/fixture",
  "https://fcm.googleapis.com@attacker.example/fixture",
  "https://name:password@fcm.googleapis.com/wp/fixture",
  "https://fcm.googleapis.com:8443/wp/fixture",
  "https://evilpush.apple.com/fixture",
  "https://notify.windows.com.attacker.example/fixture",
  "https://web.push.apple.com\\@attacker.example/fixture",
];

test("phone subscriptions reject untrusted destinations and accept supported browser providers", async () => {
  const state = new Map();
  const relay = createRelay({
    store: {
      getState: async key => state.get(key),
      setState: async (key, value) => state.set(key, value),
    },
    phoneTokenHash: await sha256Hex("test-phone"),
    homeTokenHash: await sha256Hex("test-home"),
  });
  const subscribe = endpoint => relay.handle({
    method: "POST",
    path: "/v1/subscribe",
    headers: { authorization: "Bearer test-phone" },
    body: { endpoint },
  });
  for (const endpoint of rejectedPushEndpoints) {
    assert.equal((await subscribe(endpoint)).body.code, "INVALID_ENDPOINT", endpoint);
  }
  assert.equal(state.has("push"), false);
  for (const endpoint of supportedPushEndpoints) assert.equal((await subscribe(endpoint)).status, 200, endpoint);
  assert.deepEqual(state.get("push"), [...supportedPushEndpoints].reverse());
});

test("outbound push rechecks stored endpoints and forbids redirects", async () => {
  const vapid = createVapidKeys();
  for (const endpoint of rejectedPushEndpoints) {
    assert.deepEqual(
      await sendEmptyPush({ endpoint, vapid, fetchFn: async () => assert.fail("a rejected endpoint reached fetch") }),
      { sent: false, reason: "invalid_endpoint" },
      endpoint,
    );
  }
  for (const endpoint of supportedPushEndpoints) {
    const result = await sendEmptyPush({
      endpoint,
      vapid,
      fetchFn: async (url, init) => {
        assert.equal(url, endpoint);
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.body, undefined);
        return { ok: true, status: 201 };
      },
    });
    assert.deepEqual(result, { sent: true, status: 201 });
  }
});

test("automatic sign-in probes skip workspace executables, relative PATH, and linked workspace directories", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aios-detection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const installed = path.join(root, "Installed Tools");
  const linked = path.join(root, "path-alias");
  fs.mkdirSync(workspace);
  fs.mkdirSync(installed);
  fs.symlinkSync(workspace, linked, "junction");
  const candidates = findHarness("claude").worker.binaries;
  fs.writeFileSync(path.join(workspace, candidates[0]), "", { mode: 0o700 });
  const untrustedPath = [".", "relative-bin", workspace, linked].join(path.delimiter);
  assert.equal(locateBinary(candidates, {
    env: { PATH: untrustedPath },
    workspaceRoot: workspace,
    fallbackPaths: [path.join(workspace, candidates[0])],
  }), null);
  const legitimate = path.join(installed, candidates.at(-1));
  fs.writeFileSync(legitimate, "", { mode: 0o700 });
  const probes = [];
  const agent = detectInstalledAgents({
    homeDir: root,
    workspaceRoot: workspace,
    env: { PATH: [untrustedPath, `"${installed}"`].join(path.delimiter) },
    execProbe: (file, args, options) => {
      probes.push({ file, args, options });
      return { status: 0, stdout: '{"loggedIn":true}' };
    },
  }).find(a => a.id === "claude");
  assert.equal(agent.workerPath, legitimate);
  assert.equal(agent.signedIn, true);
  assert.ok(probes.some(({ file, args, options }) =>
    options.cwd === installed && (file === legitimate || args.some(arg => arg.includes(legitimate)))));
  assert.ok(probes.every(({ file, args }) => ![file, ...args].some(arg => arg.includes(workspace) || arg.includes(linked))));
});

test("desktop documents reject framing and cross-origin writes", async t => {
  const server = createDesktopServer({ detect: () => [] });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const document = await fetch(base);
  assert.equal(document.status, 200);
  assert.match(document.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(document.headers.get("x-frame-options"), "DENY");
  assert.equal(document.headers.get("referrer-policy"), "no-referrer");
  assert.equal(document.headers.get("x-content-type-options"), "nosniff");
  assert.equal(document.headers.get("cache-control"), "no-store");
  await document.text();
  const foreign = await fetch(`${base}/api/intro/signin`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: '{"agent":"claude"}',
  });
  assert.equal(foreign.status, 403);
  await foreign.text();
});
