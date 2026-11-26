"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDaemon } = require("../../lib/v2/daemon.cjs");
const { createSecretVault } = require("../../lib/v2/auth-broker.cjs");
const { saveProfile } = require("../../lib/v2/profile.cjs");
const { runGitDefault } = require("../../lib/v2/worktree.cjs");
const { HARNESS_SPECS } = require("../../lib/v2/harnesses.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await runGitDefault(["init", "-b", "main"], { cwd: dir });
  await runGitDefault(["config", "user.name", "Test"], { cwd: dir });
  await runGitDefault(["config", "user.email", "test@localhost"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "main.js"), "console.log('v1');\n", "utf8");
  await runGitDefault(["add", "main.js"], { cwd: dir });
  await runGitDefault(["commit", "-m", "init"], { cwd: dir });
}

test("unified daemon serves single responsive UI, enforces auth, runs full chat -> plan -> build -> audit -> delivery, and connects phone/Muse", async () => {
  const tmp = mkTmp("aios-v2-e2e-");
  const backing = new Map();
  const vault = createSecretVault({ read: k => backing.get(k) ?? null, store: (k, v) => backing.set(k, v) });
  const profileDir = path.join(tmp, ".aios");
  const repo = path.join(tmp, "demo-site");
  await initRepo(repo);

  saveProfile({
    owner: "Tester",
    projectRoots: [tmp],
    projects: [{ name: "demo-site", path: repo, stakes: "sandbox", mergePolicy: "auto" }],
  }, { profileDir });

  const allSignedIn = () => HARNESS_SPECS.map(s => ({
    id: s.id, label: s.label, installed: true, headless: true, outdated: false, signedIn: true, free: s.free === true,
  }));

  const fakeRunner = async ({ provider, prompt, cwd, resultFile, onActivity }) => {
    let payload;
    if (prompt.includes("AI-first OS Intake") && prompt.includes("Can you explain the change?")) {
      assert.match(prompt, /Update main\.js greeting to v2/);
      payload = { status: "answer", answer: "The output now says v2." };
    } else if (prompt.includes("AI-first OS Intake")) {
      onActivity?.("Reading project list");
      payload = {
        status: "brief_ready",
        title: "Upgrade demo-site greeting",
        project: "demo-site",
        complexity: "trivial",
        summary: "Update main.js greeting to v2",
        requirements: ["Change the greeting printed by main.js to v2."],
      };
    } else if (prompt.includes("AI-first OS Builder")) {
      onActivity?.("Editing main.js");
      fs.writeFileSync(path.join(cwd, "main.js"), "console.log('v2');\n", "utf8");
      payload = { status: "completed", summary: "Updated greeting to v2." };
    } else if (prompt.includes("AI-first OS Independent Auditor")) {
      onActivity?.("Checking git diff");
      payload = { status: "clean", summary: "Clean single-line change verified." };
    }
    fs.writeFileSync(resultFile, JSON.stringify(payload), "utf8");
    return { ok: true, provider, exitCode: 0, structured: payload };
  };

  const daemon = createDaemon({
    profileDir,
    vault,
    detect: allSignedIn,
    runner: fakeRunner,
    listModelsFn: async provider => provider === "antigravity"
      ? ["gemini-4-neon-high", "gemini-4-carbon-medium"] : null,
  });

  try {
    const started = await daemon.start({ host: "127.0.0.1", port: 0 });
    const phoneHeaders = { "content-type": "application/json", authorization: `Bearer ${started.phoneToken}` };
    async function readFinishedTask(id) {
      let detail;
      // Windows Git worktree creation and merge can exceed a few seconds under load.
      const deadline = Date.now() + 30000;
      do {
        detail = await fetch(`${started.url}/api/v2/tasks/${id}`, { headers: phoneHeaders }).then(r => r.json());
        if (["done", "failed"].includes(detail.task.status)) return detail;
        await new Promise(resolve => setTimeout(resolve, 150));
      } while (Date.now() < deadline);
      return detail;
    }

    // 1. Serves unified HTML + CSS + JS with security headers.
    const page = await fetch(`${started.url}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(await page.text(), /What’s on your mind\?/);

    // 2. Rejects untrusted cross-origin POST.
    const badPost = await fetch(`${started.url}/api/v2/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ text: "hack" }),
    });
    assert.equal(badPost.status, 403);

    // 3. Submit request from phone bearer token -> executes pipeline -> merges sandbox repo -> returns Total Output!
    const created = await fetch(`${started.url}/api/v2/tasks`, {
      method: "POST",
      headers: phoneHeaders,
      body: JSON.stringify({ text: "Update greeting on demo-site" }),
    }).then(r => r.json());
    assert.equal(created.ok, true);

    const detail = await readFinishedTask(created.task.id);
    assert.equal(detail.task.status, "done");
    assert.equal(detail.artifacts.delivery.merged, true);
    assert.ok(Array.isArray(detail.steps) && detail.steps.length >= 4, "live steps timeline should be recorded");
    const buildStep = detail.steps.find(s => s.stage === "building");
    assert.equal(buildStep?.status, "done");
    assert.ok(buildStep?.activities.includes("Editing main.js"));
    assert.equal(fs.readFileSync(path.join(repo, "main.js"), "utf8").replace(/\r\n/g, "\n"), "console.log('v2');\n");

    const replied = await fetch(`${started.url}/api/v2/tasks/${created.task.id}/reply`, {
      method: "POST", headers: phoneHeaders, body: JSON.stringify({ text: "Can you explain the change?" }),
    }).then(r => r.json());
    assert.equal(replied.ok, true);
    assert.notEqual(replied.task.id, created.task.id);
    const followUp = await readFinishedTask(replied.task.id);
    assert.equal(followUp.task.status, "done");
    assert.equal(followUp.thread.at(-1).content, "The output now says v2.");
    assert.equal(followUp.artifacts.delivery, null);
    const preserved = await readFinishedTask(created.task.id);
    assert.deepEqual(preserved.artifacts.delivery, detail.artifacts.delivery);
    assert.equal(preserved.task.status, "done");

    // 5. Model selection & removal APIs update profile + catalog cleanly.
    const selectRes = await fetch(`${started.url}/api/v2/models/select`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: started.url },
      body: JSON.stringify({ provider: "codex", modelId: "gpt-6.3-sol" }),
    }).then(r => r.json());
    assert.equal(selectRes.ok, true);
    assert.equal(daemon.getProfile().models.overrides.codex, "gpt-6.3-sol");

    const removeRes = await fetch(`${started.url}/api/v2/models/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: started.url },
      body: JSON.stringify({ provider: "codex", modelId: "gpt-6.3-sol" }),
    }).then(r => r.json());
    assert.equal(removeRes.ok, true);
    assert.ok(daemon.getProfile().models.removedModels.includes("codex:gpt-6.3-sol"));
    assert.equal(daemon.getProfile().models.overrides.codex, "gpt-6.2-sol");

    const report = await fetch(`${started.url}/api/v2/models/refresh`, {
      method: "POST", headers: phoneHeaders,
    }).then(r => r.json());
    assert.deepEqual(report.providerResults.find(item => item.provider === "antigravity"), {
      provider: "antigravity", status: "updated", count: 2,
    });
    for (const modelId of ["gemini-4-carbon-medium", "__automatic__"]) {
      const choice = await fetch(`${started.url}/api/v2/models/select`, {
        method: "POST", headers: phoneHeaders, body: JSON.stringify({ provider: "antigravity", modelId }),
      });
      assert.equal(choice.status, 200);
    }
    const snapshot = await fetch(`${started.url}/api/v2/state`, { headers: phoneHeaders }).then(r => r.json());
    assert.equal(snapshot.modelSettings.overrides.antigravity, undefined);
    assert.equal(snapshot.modelSettings.automaticModels.antigravity, "gemini-4-neon-high");

    // 4. Enable Muse connector -> Muse gets its own bearer token -> scoped ONLY to intake routes!
    const museSetup = await fetch(`${started.url}/api/v2/connectors/token`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: started.url },
      body: JSON.stringify({ connector: "muse" }),
    }).then(r => r.json());
    assert.equal(museSetup.ok, true);
    assert.ok(museSetup.token);

    // Muse cannot call /api/v2/queue (forbidden outside /intake/*):
    const museBlocked = await fetch(`${started.url}/api/v2/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${museSetup.token}` },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(museBlocked.status, 403);

    // Muse CAN call /api/v2/intake/status:
    const museStatus = await fetch(`${started.url}/api/v2/intake/status`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${museSetup.token}` },
      body: JSON.stringify({ taskId: created.task.id }),
    }).then(r => r.json());
    assert.equal(museStatus.ok, true);
    assert.equal(museStatus.status, "done");
    assert.ok(museStatus.delivery);

    // 5. Phone pairing QR returns direct link + SVG QR.
    const pairing = await fetch(`${started.url}/api/v2/phone/pairing`).then(r => r.json());
    assert.equal(pairing.ok, true);
    assert.match(pairing.qr, /^<svg /);
  } finally {
    await daemon.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
