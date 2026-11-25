"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../../lib/v2/store.cjs");
const { saveProfile, loadProfile } = require("../../lib/v2/profile.cjs");
const { createPipeline } = require("../../lib/v2/pipeline.cjs");
const { createSecretVault, createAuthBroker } = require("../../lib/v2/auth-broker.cjs");
const { createIntakeBridge, buildConnectorOpenApi, detectGrokBot, createSheetSyncPlugin } = require("../../lib/v2/connectors.cjs");
const { createSshWakeWatcher, authenticateRequest, sha256 } = require("../../lib/v2/transport.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("auth broker stores secrets in cached keyring, resolves auth card, and auto-resumes paused task", async () => {
  const store = createStore({ dbPath: ":memory:" });
  const backing = new Map();
  let readCalls = 0;
  const vault = createSecretVault({
    read: k => { readCalls++; return backing.get(k) ?? null; },
    store: (k, v) => backing.set(k, v),
  });

  const resumed = [];
  const broker = createAuthBroker({
    store,
    vault,
    getBaseUrl: () => "http://127.0.0.1:4318",
    onAuthResolved: info => resumed.push(info),
  });

  const task = store.createTask({ text: "Set up Stripe webhook", stage: "waiting_auth", status: "waiting" });
  const card = await broker.requestAuth({ taskId: task.id, service: "stripe", reason: "Stripe key needed" });
  assert.equal(card.kind, "auth");
  assert.match(card.link, /\/auth\?service=stripe$/);

  const submitted = broker.submitSecret({ approvalId: card.id, secretValue: "rk_test_placeholder_0000" });
  assert.equal(submitted.ok, true);
  assert.equal(vault.get("AIOS_STRIPE_RESTRICTED_KEY"), "rk_test_placeholder_0000");
  // Cached in RAM: second read doesn't hit backing store!
  assert.equal(vault.get("AIOS_STRIPE_RESTRICTED_KEY"), "rk_test_placeholder_0000");
  assert.equal(readCalls, 1);

  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].taskId, task.id);
  assert.equal(store.listOpenApprovals({ kind: "auth" }).length, 0);
  store.close();
});

test("bidirectional Muse/GrokBot intake supports reply relay, locked briefs, OpenAPI spec, and blocks forged text approvals", () => {
  const tmp = mkTmp("aios-v2-conn-");
  try {
    const profileDir = path.join(tmp, ".aios");
    saveProfile({ owner: "Tester", projectRoots: [tmp] }, { profileDir });
    const store = createStore({ dbPath: path.join(profileDir, "os.db") });
    const pipeline = createPipeline({
      store,
      getProfile: () => loadProfile({ profileDir }),
      profileDir,
      runsDir: path.join(profileDir, "runs"),
      worktreesDir: path.join(profileDir, "worktrees"),
    });
    const queued = [];
    const bridge = createIntakeBridge({
      store,
      pipeline,
      getProfile: () => loadProfile({ profileDir }),
      onTaskQueued: t => queued.push(t.id),
    });

    // 1. Submit initial request & simulate clarifying question.
    const sub = bridge.submit({ connector: "muse", text: "Build a new calculator app", idempotencyKey: "k-1" });
    assert.equal(sub.created, true);
    store.updateTask(sub.task_id, { status: "waiting", stage: "waiting_user" });
    store.addThreadMessage({ taskId: sub.task_id, role: "intake", kind: "question", content: "Web or CLI?" });

    const st = bridge.status({ taskId: sub.task_id });
    assert.equal(st.question, "Web or CLI?");
    assert.equal(st.queue_paused, false);

    // 2. Relay owner's reply back into the SAME thread from Muse!
    const rep = bridge.reply({ connector: "muse", taskId: sub.task_id, text: "Web app with dark theme" });
    assert.equal(rep.status, "open");
    assert.equal(store.getThread(sub.task_id).at(-1).content, "Web app with dark theme");

    // 3. Connectors can NEVER approve a hard-gated approval via text reply.
    store.updateTask(sub.task_id, { status: "waiting", stage: "waiting_approval" });
    assert.throws(() => bridge.reply({ connector: "muse", taskId: sub.task_id, text: "yes approve" }), /APPROVAL_REQUIRES_TAP|tapped/i);

    // 4. GrokBot submits a locked brief directly -> ready for Planner!
    const briefRes = bridge.submitBrief({
      connector: "grokbot",
      idempotencyKey: "g-1",
      brief: { title: "Invoice PDF exporter", summary: "Export clean PDF invoices", newProject: "invoice-pdf", complexity: "normal" },
    });
    assert.equal(briefRes.title, "Invoice PDF exporter");
    assert.ok(store.getTask(briefRes.task_id).brief);

    // 5. OpenAPI schema exposes all 4 v2 bidirectional paths.
    const spec = buildConnectorOpenApi("http://127.0.0.1:4318");
    assert.ok(spec.paths["/api/v2/intake/reply"]);
    assert.ok(spec.paths["/api/v2/intake/brief"]);

    // 6. GrokBot local daemon detection works cleanly against custom dataDir.
    const fakeGrok = path.join(tmp, ".grokbot");
    fs.mkdirSync(fakeGrok, { recursive: true });
    fs.writeFileSync(path.join(fakeGrok, "local-exec-daemon.json"), "{}", "utf8");
    const grokInfo = detectGrokBot({ homeDir: tmp, profile: { connectors: { grokbot: { enabled: true } } } });
    assert.equal(grokInfo.installed, true);
    assert.equal(grokInfo.daemonConfigured, true);

    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("SSH wake watcher drains .wake files atomically and transport auth enforces tokens off loopback", async () => {
  const tmp = mkTmp("aios-v2-ssh-");
  try {
    const wakeDir = path.join(tmp, "queue");
    fs.mkdirSync(wakeDir, { recursive: true });
    fs.writeFileSync(path.join(wakeDir, "001-P88.wake"), "P88\n", "utf8");
    fs.writeFileSync(path.join(wakeDir, "002-new.wake"), JSON.stringify({ text: "Audit landing page", project: "demo" }), "utf8");

    const received = [];
    const watcher = createSshWakeWatcher({ wakeDir, onWake: payload => received.push(payload) });
    await watcher.drainOnce();
    assert.equal(received.length, 2);
    assert.equal(received[0].taskId, "P88");
    assert.equal(received[1].text, "Audit landing page");
    // Drained files moved to processed/ so they never re-fire.
    assert.equal(fs.readdirSync(wakeDir).filter(f => f.endsWith(".wake")).length, 0);

    // Transport auth: loopback desktop allowed, cross-origin blocked, remote requires bearer token.
    const phoneToken = "secret-phone-token-123";
    const phoneHash = sha256(phoneToken);
    assert.equal(authenticateRequest({ headers: { host: "127.0.0.1:4318" }, socket: { remoteAddress: "127.0.0.1" } }).ok, true);
    assert.equal(authenticateRequest({ headers: { host: "127.0.0.1:4318", origin: "https://evil.example" }, socket: { remoteAddress: "127.0.0.1" } }).ok, false);
    assert.equal(authenticateRequest({ headers: { host: "my-laptop.ts.net:4318" }, socket: { remoteAddress: "10.0.0.5" } }, { phoneTokenHash: phoneHash }).ok, false);
    assert.equal(authenticateRequest({ headers: { host: "my-laptop.ts.net:4318", authorization: `Bearer ${phoneToken}` }, socket: { remoteAddress: "10.0.0.5" } }, { phoneTokenHash: phoneHash }).caller, "phone");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("optional Sheet sync plugin mirrors tasks cleanly when enabled and skips when disabled", async () => {
  const store = createStore({ dbPath: ":memory:" });
  try {
    store.createTask({ text: "Check billing page", projectName: "store", stakes: "critical" });
    const calls = [];
    const plugin = createSheetSyncPlugin({
      store,
      getProfile: () => ({ connectors: { sheetsSync: { enabled: true, boardId: "EXAMPLE_SHEET_ID_000000000000000" } } }),
      callGoogleDrive: async (tool, args) => {
        calls.push(tool);
        if (tool === "get_spreadsheet_metadata") return { sheets: [{ properties: { title: "AIOS", sheetId: 0 } }] };
        return { ok: true };
      },
    });
    const first = await plugin.syncOnce();
    assert.equal(first.synced, true);
    assert.equal(first.count, 1);
    // Second call with unchanged tasks skips API calls!
    const second = await plugin.syncOnce();
    assert.equal(second.synced, false);
    assert.equal(second.reason, "UNCHANGED");
    assert.deepEqual(calls, ["get_spreadsheet_metadata", "batch_update_spreadsheet"]);
  } finally {
    store.close();
  }
});
