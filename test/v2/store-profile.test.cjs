"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../../lib/v2/store.cjs");
const {
  loadProfile, saveProfile, listAllProjects, resolveProject,
  stakesForProject, mergePolicyForProject, createManagedProject,
} = require("../../lib/v2/profile.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("SQLite store persists tasks, threads, agent bus, quotas, models, and approvals cleanly", () => {
  const dir = mkTmp("aios-v2-store-");
  try {
    let clock = 1_700_000_000_000;
    const dbPath = path.join(dir, "os.db");
    const store = createStore({ dbPath, now: () => clock });

    // Create task with idempotency receipt.
    const t1 = store.createTask({
      text: "Fix checkout flow on flagship store",
      source: "phone",
      sourceRef: "req-uuid-1",
      projectName: "flagship-store",
      stakes: "critical",
    });
    assert.equal(t1.id, "T1");
    assert.equal(t1.stakes, "critical");
    const dup = store.createTask({ text: "Fix checkout flow on flagship store", source: "phone", sourceRef: "req-uuid-1" });
    assert.equal(dup.id, t1.id);
    assert.throws(() => store.createTask({ text: "Different text", source: "phone", sourceRef: "req-uuid-1" }), /SOURCE_CONFLICT|different/i);

    // Long thread messages are never truncated at 500 chars.
    const longMsg = "X".repeat(8000);
    store.addThreadMessage({ taskId: t1.id, role: "builder", agent: "claude", content: longMsg });
    const thread = store.getThread(t1.id);
    assert.equal(thread.length, 2);
    assert.equal(thread[1].content.length, 8000);

    // Agent bus messages persist cleanly.
    store.addBusMessage({ taskId: t1.id, fromAgent: "codex", toAgent: "claude", msgType: "audit_findings", payload: { findings: ["Check null guard"] } });
    assert.equal(store.getBusMessages(t1.id)[0].msgType, "audit_findings");

    // Quotas survive store close + reopen.
    store.setQuota({ provider: "claude", status: "exhausted", resetAt: clock + 3600_000, reason: "session_limit" });
    store.upsertModel({ provider: "codex", modelId: "gpt-6.2-sol", tier: "workhorse", effortLevels: ["medium", "high", "ultra"], status: "verified", isDefault: true, verifiedAt: clock });

    // Approval bound to digest + expiry.
    const approval = store.createApproval({
      taskId: t1.id,
      kind: "approval",
      title: "Merge production PR",
      prompt: "Merge branch aios/t1 into main?",
      choices: [{ label: "Merge", value: "yes" }, { label: "Hold", value: "no" }],
    });
    assert.throws(() => store.answerApproval({ id: approval.id, value: "yes", digest: "wrong" }), /mismatch/i);
    const answered = store.answerApproval({ id: approval.id, value: "yes", digest: approval.digest, source: "phone" });
    assert.equal(answered.answerValue, "yes");

    // Atomic claim respects queue pause.
    store.setQueuePaused(true);
    assert.throws(() => store.claimTask(t1.id, { agent: "claude" }), /paused/i);
    store.setQueuePaused(false);
    const claimed = store.claimTask(t1.id, { agent: "claude", model: "claude-opus-5-5", effort: "high", stage: "planning" });
    assert.equal(claimed.task.status, "running");
    assert.equal(claimed.task.assignedAgent, "claude");
    store.close();

    // Reopen and verify persistence + interrupted task recovery.
    const reopened = createStore({ dbPath, now: () => clock + 1000 });
    assert.equal(reopened.getQuota("claude").status, "exhausted");
    assert.equal(reopened.getQuota("claude").resetAt, clock + 3600_000);
    assert.equal(reopened.listModels({ provider: "codex" })[0].modelId, "gpt-6.2-sol");
    assert.equal(reopened.recoverInterruptedTasks(), 1);
    assert.equal(reopened.getTask(t1.id).status, "waiting");
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("profile supports multi-root project discovery, space-insensitive alias resolution, and stakes policies", async () => {
  const tmp = mkTmp("aios-v2-prof-");
  try {
    const profileDir = path.join(tmp, ".aios");
    const rootA = path.join(tmp, "DriveA");
    const rootB = path.join(tmp, "DriveB");
    const nested = path.join(rootB, "Suite", "acme-store");
    fs.mkdirSync(path.join(rootA, "sandbox-demo", ".git"), { recursive: true });
    fs.mkdirSync(path.join(nested, ".git"), { recursive: true });

    const profile = saveProfile({
      owner: "Tester",
      projectRoots: [rootA, rootB],
      newProjectsRoot: rootA,
      projects: [{
        name: "acme-store",
        path: nested,
        stakes: "critical",
        aliases: ["Acme Store", "acme.example"],
      }],
    }, { profileDir });

    const loaded = loadProfile({ profileDir });
    const all = listAllProjects(loaded);
    assert.equal(all.length, 2);

    // Space-insensitive matching fixes "AcmeStore" vs "Acme Store".
    const hit = resolveProject("Update pricing on AcmeStore today", all);
    assert.equal(hit?.name, "acme-store");
    assert.equal(stakesForProject(hit, loaded), "critical");
    assert.equal(mergePolicyForProject(hit, loaded), "ask");

    const sb = resolveProject("sandbox-demo", all);
    assert.equal(sb?.name, "sandbox-demo");
    assert.equal(stakesForProject(sb, loaded), "standard");

    // Creating a managed project puts it inside newProjectsRoot (not homeDir) with git init + initial commit.
    const created = await createManagedProject({ profile: loaded, profileDir, name: "New Side Idea", stakes: "sandbox" });
    assert.equal(created.name, "new-side-idea");
    assert.equal(path.dirname(created.path), rootA);
    assert.equal(mergePolicyForProject(created, loaded), "auto");
    assert.ok(fs.existsSync(path.join(created.path, ".git")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
