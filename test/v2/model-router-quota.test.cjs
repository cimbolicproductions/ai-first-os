"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../../lib/v2/store.cjs");
const { parseResetAt, classifyProviderFailure, recordProviderFailure, getEffectiveProviderQuota } = require("../../lib/v2/quota.cjs");
const { classifyModelTier, refreshModelCatalog, resolveModelForProvider } = require("../../lib/v2/model-catalog.cjs");
const { selectAssignment, stagePolicy } = require("../../lib/v2/router.cjs");
const { HARNESS_SPECS, getHarness, extractStructuredOutput } = require("../../lib/v2/harnesses.cjs");

function fakeDetected(overrides = {}) {
  return HARNESS_SPECS.map(spec => ({
    id: spec.id,
    label: spec.label,
    installed: true,
    headless: true,
    outdated: false,
    signedIn: true,
    free: spec.free === true,
    ...(overrides[spec.id] || {}),
  }));
}

test("quota parser handles Claude Chicago clock resets, Codex dated resets, relative durations, and auth expiry", () => {
  const baseNow = Date.UTC(2026, 10, 15, 16, 0, 0); // 2026-11-15 10:00 AM America/Chicago (CST = UTC-6)

  // Claude format: "resets 12:20pm (America/Chicago)" -> same day 18:20 UTC
  const claudeTs = parseResetAt("You've hit your session limit · resets 12:20pm (America/Chicago)", { now: baseNow });
  assert.equal(claudeTs, Date.UTC(2026, 10, 15, 18, 20, 0));

  // Claude format past current hour wraps to tomorrow: "resets 8:00am (America/Chicago)" -> Nov 16 14:00 UTC
  const claudeTomorrow = parseResetAt("resets 8:00am (America/Chicago)", { now: baseNow });
  assert.equal(claudeTomorrow, Date.UTC(2026, 10, 16, 14, 0, 0));

  // Codex format: "try again at Nov 16th, 2026 7:47 AM" (in Chicago)
  const codexTs = parseResetAt("try again at Nov 16th, 2026 7:47 AM", { now: baseNow, defaultTimeZone: "America/Chicago" });
  assert.equal(codexTs, Date.UTC(2026, 10, 16, 13, 47, 0));

  // Relative format
  const relTs = parseResetAt("Rate limit exceeded. Try again in 20 minutes.", { now: baseNow });
  assert.equal(relTs, baseNow + 20 * 60 * 1000);

  // Auth expiry is classified separately from quota exhaustion
  const auth = classifyProviderFailure("claude", "Error: OAuth token expired. Please log in again.", { now: baseNow });
  assert.equal(auth.kind, "auth_expired");
});

test("model catalog classifies apex above workhorse, canary-verifies new models, and asks before promoting", async () => {
  const store = createStore({ dbPath: ":memory:" });
  try {
    assert.equal(classifyModelTier("codex", "gpt-7.0-fable"), "apex");
    assert.equal(classifyModelTier("claude", "claude-astra-1"), "apex");
    assert.equal(classifyModelTier("codex", "gpt-6.2-sol"), "workhorse");
    assert.equal(classifyModelTier("claude", "claude-opus-5-5"), "workhorse");
    assert.equal(classifyModelTier("claude", "sonnet"), "balanced");
    assert.equal(classifyModelTier("opencode", "opencode/deepseek-v4.1-flash-free"), "fast-free");

    const res = await refreshModelCatalog({
      store,
      profile: { models: { preferBelowApex: true, autoPromoteSandbox: false } },
      providers: ["codex"],
      listModelsForProvider: async () => ["gpt-6.3-sol", "gpt-7.0-fable"],
      canaryProbe: async () => ({ ok: true }),
    });

    // gpt-6.3-sol is newer workhorse -> raises 1-tap promotion card; gpt-7.0-fable stays apex (not promoted into workhorse).
    assert.equal(res.pendingApprovals.length, 1);
    assert.equal(res.pendingApprovals[0].meta.modelId, "gpt-6.3-sol");
    assert.equal(res.pendingApprovals[0].meta.tier, "workhorse");

    // Default workhorse stays gpt-6.2-sol until owner approves promotion.
    const before = resolveModelForProvider({ store, profile: {}, provider: "codex", desiredTier: "workhorse", desiredEffort: "xhigh" });
    assert.equal(before.modelId, "gpt-6.2-sol");
    assert.equal(before.effort, "ultra"); // xhigh maps cleanly to Codex's ultra!

    store.setDefaultModel("codex", "workhorse", "gpt-6.3-sol");
    const after = resolveModelForProvider({ store, profile: {}, provider: "codex", desiredTier: "workhorse", desiredEffort: "high" });
    assert.equal(after.modelId, "gpt-6.3-sol");
  } finally {
    store.close();
  }
});

test("2D stakes x stage router enforces flagship floor & distinct audit on critical repos, cheap build on sandbox, and full failover", () => {
  let clock = 1_700_000_000_000;
  const store = createStore({ dbPath: ":memory:", now: () => clock });
  try {
    const detected = fakeDetected();

    // Critical build: picks workhorse + high effort (never drops to free).
    const critBuild = selectAssignment({ store, profile: {}, detected, stakes: "critical", stage: "building", now: clock });
    assert.equal(critBuild.ok, true);
    assert.equal(critBuild.tier, "workhorse");
    assert.equal(critBuild.effort, "high");

    // Critical audit: MUST differ from builder!
    const critAudit = selectAssignment({ store, profile: {}, detected, stakes: "critical", stage: "auditing", builderProvider: critBuild.provider, now: clock });
    assert.equal(critAudit.ok, true);
    assert.notEqual(critAudit.provider, critBuild.provider);
    assert.equal(critAudit.tier, "workhorse");

    // Exhaust ALL workhorse providers on critical build -> returns QUOTA_WAIT (never silently drops to opencode free!).
    for (const p of ["claude", "codex", "antigravity", "gemini"]) {
      recordProviderFailure(store, { kind: "exhausted", provider: p, resetAt: clock + 3600_000, reason: "limit" });
    }
    const blockedCrit = selectAssignment({ store, profile: {}, detected, stakes: "critical", stage: "building", now: clock });
    assert.equal(blockedCrit.ok, false);
    assert.equal(blockedCrit.code, "QUOTA_WAIT");
    assert.equal(blockedCrit.earliestResetAt, clock + 3600_000);

    // Meanwhile a sandbox build still runs immediately on OpenCode (free) without waiting!
    const sandboxBuild = selectAssignment({ store, profile: {}, detected, stakes: "sandbox", stage: "building", now: clock });
    assert.equal(sandboxBuild.ok, true);
    assert.equal(sandboxBuild.provider, "opencode");

    // Advance clock past reset -> workhorse provider auto-recovers!
    clock += 3600_001;
    assert.equal(getEffectiveProviderQuota(store, "claude", { now: clock }).available, true);
    const recovered = selectAssignment({ store, profile: {}, detected, stakes: "critical", stage: "building", now: clock });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.provider, "claude");

    // Standard repo skips standalone planning for trivial changes, and escalates builder from balanced -> workhorse on escalationLevel >= 1.
    assert.equal(stagePolicy({ stakes: "standard", stage: "planning", complexity: "trivial" }).skip, true);
    assert.equal(stagePolicy({ stakes: "standard", stage: "building", escalationLevel: 0 }).desiredTier, "balanced");
    assert.equal(stagePolicy({ stakes: "standard", stage: "fixing", escalationLevel: 1 }).desiredTier, "workhorse");
  } finally {
    store.close();
  }
});

test("harnesses include restored Gemini CLI and extract structured output from file, marker, or fenced JSON despite trailing prose", () => {
  assert.ok(getHarness("gemini"), "Gemini CLI must be a first-class harness");
  assert.equal(HARNESS_SPECS.length, 6);

  // Trailing commentary after AIOS-RESULT no longer breaks parsing!
  const markerOut = extractStructuredOutput({
    stdout: 'Did the work.\nAIOS-RESULT: {"status":"completed","summary":"Built page"}\nHave a great day!',
  });
  assert.equal(markerOut?.source, "marker");
  assert.equal(markerOut?.data.summary, "Built page");

  // File-first output wins even if stdout has warnings.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aios-v2-out-"));
  try {
    const file = path.join(tmp, "stage-result.json");
    fs.writeFileSync(file, JSON.stringify({ status: "findings", findings: [{ file: "a.js", detail: "Missing check" }] }), "utf8");
    const fileOut = extractStructuredOutput({ resultFile: file, stdout: "noisy stderr/stdout warning" });
    assert.equal(fileOut?.source, "file");
    assert.equal(fileOut?.data.findings.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
