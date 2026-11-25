"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../../lib/v2/store.cjs");
const { saveProfile, loadProfile } = require("../../lib/v2/profile.cjs");
const { runGitDefault } = require("../../lib/v2/worktree.cjs");
const { createPipeline } = require("../../lib/v2/pipeline.cjs");
const { HARNESS_SPECS } = require("../../lib/v2/harnesses.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await runGitDefault(["init", "-b", "main"], { cwd: dir });
  await runGitDefault(["config", "user.name", "Test"], { cwd: dir });
  await runGitDefault(["config", "user.email", "test@localhost"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = () => 1;\n", "utf8");
  await runGitDefault(["add", "index.js"], { cwd: dir });
  await runGitDefault(["commit", "-m", "init"], { cwd: dir });
}

function allSignedIn() {
  return HARNESS_SPECS.map(s => ({
    id: s.id, label: s.label, installed: true, headless: true, outdated: false, signedIn: true, free: s.free === true,
  }));
}

test("full 3-stage critical pipeline: brief -> workhorse plan -> builder clarifies with planner -> workhorse build -> distinct auditor findings -> fix -> clean -> 1-tap ship", async () => {
  const tmp = mkTmp("aios-v2-pipe-");
  try {
    const profileDir = path.join(tmp, ".aios");
    const repo = path.join(tmp, "business-app");
    const vault = path.join(tmp, "Vault");
    fs.mkdirSync(vault, { recursive: true });
    await initRepo(repo);

    saveProfile({
      owner: "Tester",
      vaultPath: vault,
      projectRoots: [tmp],
      projects: [{ name: "business-app", path: repo, stakes: "critical", mergePolicy: "ask" }],
    }, { profileDir });

    const store = createStore({ dbPath: path.join(profileDir, "os.db") });
    const calls = [];
    let buildAttempt = 0;
    let auditAttempt = 0;

    const fakeRunner = async ({ provider, prompt, cwd, resultFile, mode, model, effort }) => {
      calls.push({ provider, mode, model, effort });
      let payload;

      if (prompt.includes("Builder Clarification Request")) {
        payload = { status: "plan_answer", answer: "Return 42 for valid input.", planAddendum: "Export value 42." };
      } else if (prompt.includes("AI-first OS Architect / Planner")) {
        payload = { status: "plan_ready", planMarkdown: "# Plan\nUpdate index.js to export 42.\n", verificationCommands: ["node -e 'process.exit(0)'"] };
      } else if (prompt.includes("AI-first OS Builder")) {
        buildAttempt++;
        if (buildAttempt === 1) {
          // Builder asks Planner a technical question on the terminal bus!
          payload = { status: "clarify_plan", question: "Should index.js return 42 or 41?" };
        } else if (buildAttempt === 2) {
          fs.writeFileSync(path.join(cwd, "index.js"), "module.exports = () => 41;\n", "utf8");
          payload = { status: "completed", summary: "Updated index.js." };
        } else {
          // Fix round addresses audit finding!
          fs.writeFileSync(path.join(cwd, "index.js"), "module.exports = () => 42;\n", "utf8");
          payload = { status: "completed", summary: "Fixed index.js to return 42." };
        }
      } else if (prompt.includes("AI-first OS Independent Auditor")) {
        auditAttempt++;
        // Verify auditor receives real ground-truth diff!
        assert.match(prompt, /Ground-Truth Git Diff/);
        if (auditAttempt === 1) {
          assert.match(prompt, /\+module\.exports = \(\) => 41;/);
          payload = {
            status: "findings",
            summary: "Wrong return value",
            findings: [{ file: "index.js", line: 1, severity: "high", detail: "Returns 41 instead of 42", suggestedFix: "Change 41 to 42" }],
          };
        } else {
          assert.match(prompt, /\+module\.exports = \(\) => 42;/);
          payload = { status: "clean", summary: "Diff returns 42 and matches plan." };
        }
      }

      fs.writeFileSync(resultFile, JSON.stringify(payload), "utf8");
      return { ok: true, provider, exitCode: 0, stdout: "", stderr: "", structured: payload };
    };

    const pipeline = createPipeline({
      store,
      getProfile: () => loadProfile({ profileDir }),
      profileDir,
      runsDir: path.join(profileDir, "runs"),
      worktreesDir: path.join(profileDir, "worktrees"),
      detect: allSignedIn,
      runner: fakeRunner,
      runVerification: async () => ({ ok: true, output: "All checks passed." }),
    });

    // Simulate locked brief coming in from Muse/GrokBot!
    const task = store.createTask({
      title: "Return 42 from business-app",
      text: "Update index.js to return 42",
      source: "muse",
      projectName: "business-app",
      projectPath: repo,
      stakes: "critical",
      brief: { title: "Return 42 from business-app", project: "business-app", complexity: "normal", summary: "Update index.js to return 42" },
    });

    const res = await pipeline.processTask(task.id);
    assert.equal(res.status, "ready_to_ship");
    assert.equal(res.delivery.awaitingShip, true);
    assert.equal(res.delivery.merged, false);
    assert.equal(res.delivery.auditRounds, 2);
    // Distinct auditor invariant verified!
    assert.notEqual(res.delivery.builder, res.delivery.auditor);

    // Terminal bus recorded the full agent-to-agent conversation!
    const bus = store.getBusMessages(task.id).map(m => m.msgType);
    assert.deepEqual(bus, ["plan_ready", "clarify_plan", "plan_answer", "build_complete", "audit_findings", "fix_applied", "audit_clean"]);

    // Main repo is still untouched until owner taps Merge!
    assert.equal(fs.readFileSync(path.join(repo, "index.js"), "utf8").replace(/\r\n/g, "\n"), "module.exports = () => 1;\n");

    // Obsidian vault received the delivery note!
    assert.ok(fs.existsSync(path.join(vault, "AI-first OS", "Projects", "business-app.md")));

    // 1-tap Ship approval merges cleanly into main!
    const shipApproval = store.listOpenApprovals({ taskId: task.id, kind: "ship" })[0];
    assert.ok(shipApproval);
    store.answerApproval({ id: shipApproval.id, value: "merge", digest: shipApproval.digest, source: "phone" });
    const shipped = await pipeline.executeShipApproval(shipApproval, "merge");
    assert.equal(shipped.ok, true);
    assert.equal(shipped.merged, true);
    assert.equal(fs.readFileSync(path.join(repo, "index.js"), "utf8").replace(/\r\n/g, "\n"), "module.exports = () => 42;\n");

    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a Codex limit hands the same worktree to Claude and then Antigravity", async () => {
  const tmp = mkTmp("aios-v2-failover-");
  try {
    const profileDir = path.join(tmp, ".aios");
    const repo = path.join(tmp, "side-toy");
    await initRepo(repo);

    saveProfile({
      owner: "Tester",
      projectRoots: [tmp],
      projects: [{ name: "side-toy", path: repo, stakes: "sandbox", mergePolicy: "auto" }],
    }, { profileDir });

    const store = createStore({ dbPath: path.join(profileDir, "os.db") });
    const triedBuilders = [];
    store.upsertModel({
      provider: "antigravity", modelId: "gemini-4-neon-high", tier: "workhorse",
      effortLevels: ["high"], status: "listed", isDefault: true,
    });

    const fakeRunner = async ({ provider, prompt, cwd, resultFile }) => {
      if (prompt.includes("AI-first OS Builder")) {
        triedBuilders.push(provider);
        if (provider === "codex") {
          fs.writeFileSync(path.join(cwd, "checkpoint.txt"), "Partial work from Codex.\n");
        } else {
          assert.equal(fs.readFileSync(path.join(cwd, "checkpoint.txt"), "utf8"), "Partial work from Codex.\n");
          assert.match(prompt, /## Worker handoff/);
          assert.match(prompt, /Continue in this same worktree/);
          assert.match(prompt, /Keep the public interface unchanged\./);
        }
        if (provider === "codex" || provider === "claude") {
          return {
            ok: false,
            provider,
            exitCode: 1,
            failure: { kind: "exhausted", provider, resetAt: Date.now() + 3600_000, reason: "Usage limit reached" },
          };
        }
        fs.writeFileSync(path.join(cwd, "index.js"), "module.exports = () => 99;\n", "utf8");
        const payload = { status: "completed", summary: "Updated sandbox to 99." };
        fs.writeFileSync(resultFile, JSON.stringify(payload), "utf8");
        return { ok: true, provider, exitCode: 0, structured: payload };
      }
      if (prompt.includes("AI-first OS Independent Auditor")) {
        const payload = { status: "clean", summary: "Looks good." };
        fs.writeFileSync(resultFile, JSON.stringify(payload), "utf8");
        return { ok: true, provider, exitCode: 0, structured: payload };
      }
      return { ok: false, provider, exitCode: 1, failure: { kind: "error", provider, reason: "unexpected" } };
    };

    const pipeline = createPipeline({
      store,
      getProfile: () => loadProfile({ profileDir }),
      profileDir,
      runsDir: path.join(profileDir, "runs"),
      worktreesDir: path.join(profileDir, "worktrees"),
      detect: allSignedIn,
      runner: fakeRunner,
    });

    const task = store.createTask({
      title: "Quick tweak on side-toy",
      text: "Update index.js to 99",
      projectName: "side-toy",
      projectPath: repo,
      stakes: "sandbox",
      brief: { title: "Quick tweak on side-toy", project: "side-toy", complexity: "trivial", summary: "Update index.js to 99" },
    });
    store.updateTask(task.id, { assignedAgent: "codex" });
    store.addThreadMessage({ taskId: task.id, role: "owner", content: "Keep the public interface unchanged." });

    const res = await pipeline.processTask(task.id);
    assert.equal(res.status, "done");
    assert.equal(res.delivery.merged, true);
    assert.deepEqual(triedBuilders, ["codex", "claude", "antigravity"]);
    assert.equal(store.getQuota(triedBuilders[0]).status, "exhausted");
    assert.equal(store.getBusMessages(task.id).filter(message => message.msgType === "worker_handoff").length, 2);
    assert.equal(fs.readFileSync(path.join(repo, "index.js"), "utf8").replace(/\r\n/g, "\n"), "module.exports = () => 99;\n");

    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
