"use strict";

const { TIER_RANK, resolveModelForProvider, seedBaselineModels } = require("./model-catalog.cjs");
const { getEffectiveProviderQuota } = require("./quota.cjs");

/**
 * 2D Stakes x Stage Auto-Router with Unlimited Failover & Intelligence Floors.
 *
 * Automatically chooses the optimal (subscription, model, reasoning effort)
 * based on:
 *   1. Project stakes (critical | standard | sandbox)
 *   2. Pipeline stage (intake | planning | building | auditing | fixing)
 *   3. Task complexity (trivial | normal | complex) & escalation level
 *   4. Live subscription health + persisted quota cooldowns
 *
 * Guarantees:
 * - Critical business repos NEVER drop below workhorse flagship or self-audit.
 * - Standard repos plan with workhorse, implement with balanced, audit with distinct workhorse.
 * - Sandbox repos conserve flagship usage with fast/cheap builders and auto-escalate only if stuck.
 * - Failover spans ALL signed-in eligible subscriptions (no 2-agent cap).
 */

const PROVIDER_PREFERENCE = Object.freeze({
  intake: ["opencode", "antigravity", "claude", "codex"],
  planning: ["claude", "codex", "antigravity", "opencode"],
  building: ["claude", "codex", "antigravity", "opencode"],
  fixing: ["claude", "codex", "antigravity", "opencode"],
  auditing: ["codex", "claude", "antigravity", "opencode"],
});

/**
 * Computes the exact intelligence & effort policy for a (stakes, stage) cell.
 */
function stagePolicy({ stakes = "standard", stage = "building", complexity = "normal", escalationLevel = 0 }) {
  const s = ["critical", "standard", "sandbox"].includes(stakes) ? stakes : "standard";
  const esc = Math.max(0, Number(escalationLevel) || 0);

  if (stage === "intake") {
    return {
      skip: false,
      desiredTier: s === "critical" ? "balanced" : "fast-free",
      minTier: "fast-free",
      effort: "low",
      allowApex: false,
      mustDifferFromBuilder: false,
    };
  }

  if (stage === "planning") {
    if (complexity === "trivial" && s !== "critical") {
      return { skip: true, reason: "Trivial change on non-critical repo skips standalone planning." };
    }
    if (s === "critical") {
      return {
        skip: false,
        desiredTier: esc >= 2 ? "apex" : "workhorse",
        minTier: "workhorse",
        effort: esc >= 1 ? "xhigh" : "high",
        allowApex: esc >= 2,
        mustDifferFromBuilder: false,
      };
    }
    if (s === "standard") {
      return {
        skip: false,
        desiredTier: "workhorse",
        minTier: "balanced",
        effort: complexity === "complex" ? "xhigh" : "high",
        allowApex: esc >= 2,
        mustDifferFromBuilder: false,
      };
    }
    // sandbox
    return {
      skip: false,
      desiredTier: "balanced",
      minTier: "fast-free",
      effort: "medium",
      allowApex: false,
      mustDifferFromBuilder: false,
    };
  }

  if (stage === "building" || stage === "fixing") {
    if (s === "critical") {
      return {
        skip: false,
        desiredTier: esc >= 2 ? "apex" : "workhorse",
        minTier: "workhorse",
        effort: esc >= 1 ? "xhigh" : "high",
        allowApex: esc >= 2,
        mustDifferFromBuilder: false,
      };
    }
    if (s === "standard") {
      // Standard repos implement with balanced models from the detailed plan, escalating to workhorse if fixes stall.
      const escalated = esc >= 1;
      return {
        skip: false,
        desiredTier: escalated ? "workhorse" : "balanced",
        minTier: escalated ? "workhorse" : "balanced",
        effort: escalated ? "high" : "medium",
        allowApex: esc >= 3,
        mustDifferFromBuilder: false,
      };
    }
    // sandbox
    const escalated = esc >= 1;
    return {
      skip: false,
      desiredTier: escalated ? "balanced" : "fast-free",
      minTier: "fast-free",
      effort: escalated ? "medium" : "low",
      allowApex: false,
      mustDifferFromBuilder: false,
    };
  }

  if (stage === "auditing") {
    if (s === "critical") {
      return {
        skip: false,
        desiredTier: esc >= 2 ? "apex" : "workhorse",
        minTier: "workhorse",
        effort: "xhigh",
        allowApex: esc >= 2,
        mustDifferFromBuilder: true,
      };
    }
    if (s === "standard") {
      return {
        skip: false,
        desiredTier: "workhorse",
        minTier: "balanced",
        effort: "high",
        allowApex: esc >= 2,
        mustDifferFromBuilder: true,
      };
    }
    // sandbox
    return {
      skip: false,
      desiredTier: "balanced",
      minTier: "fast-free",
      effort: "medium",
      allowApex: false,
      mustDifferFromBuilder: false, // prefers distinct, allows fallback only when 1 provider exists
    };
  }

  return {
    skip: false,
    desiredTier: "balanced",
    minTier: "fast-free",
    effort: "medium",
    allowApex: false,
    mustDifferFromBuilder: false,
  };
}

/**
 * Selects the optimal (provider, modelId, effort) across all signed-in subscriptions.
 */
function selectAssignment({
  store,
  profile,
  detected = [],
  stakes = "standard",
  stage = "building",
  complexity = "normal",
  escalationLevel = 0,
  preferredProvider = null,
  builderProvider = null,
  excludeProviders = [],
  now = Date.now(),
}) {
  seedBaselineModels(store, profile);
  const policy = stagePolicy({ stakes, stage, complexity, escalationLevel });
  if (policy.skip) return { ok: true, skipped: true, reason: policy.reason, policy };

  const excluded = new Set((excludeProviders || []).map(p => String(p).toLowerCase()));
  const minRank = TIER_RANK[policy.minTier] || 1;
  const desiredRank = TIER_RANK[policy.desiredTier] || 2;
  const order = PROVIDER_PREFERENCE[stage] || PROVIDER_PREFERENCE.building;
  const detectedMap = new Map(detected.map(d => [d.id, d]));

  const eligible = [];
  const exhaustedWaiters = [];
  const authNeeded = [];

  for (const agent of detected) {
    if (!agent.installed || !agent.headless || agent.outdated) continue;
    const provider = agent.id;
    if (excluded.has(provider)) continue;

    // Distinct-auditor invariant: never let a builder audit itself when mustDifferFromBuilder is true.
    if (stage === "auditing" && builderProvider && provider === builderProvider && policy.mustDifferFromBuilder) {
      continue;
    }

    const chosen = resolveModelForProvider({
      store,
      profile,
      provider,
      desiredTier: policy.desiredTier,
      desiredEffort: policy.effort,
      allowApex: policy.allowApex,
    });
    if (chosen.disabled || !chosen.modelId) continue;
    const modelRank = TIER_RANK[chosen.tier] || 1;
    if (modelRank < minRank) continue;

    // Check sign-in & quota status.
    const quota = getEffectiveProviderQuota(store, provider, { now });
    if (!agent.signedIn || quota.needsAuth) {
      authNeeded.push({ provider, label: agent.label, tier: chosen.tier });
      continue;
    }
    if (!quota.available) {
      exhaustedWaiters.push({ provider, label: agent.label, resetAt: quota.resetAt, tier: chosen.tier });
      continue;
    }

    // Score candidate: prefer explicit override -> distinct from builder -> exact tier match -> preference order.
    let score = 0;
    if (preferredProvider && provider === preferredProvider) score += 1000;
    if (stage === "auditing" && builderProvider && provider !== builderProvider) score += 500;
    const tierDist = Math.abs(modelRank - desiredRank);
    score += Math.max(0, 200 - tierDist * 60);
    // For sandbox building, explicitly prefer free/fast models before burning paid subscriptions.
    if (stakes === "sandbox" && (stage === "building" || stage === "intake") && agent.free) score += 150;
    const prefIdx = order.indexOf(provider);
    score += prefIdx === -1 ? 0 : Math.max(0, 50 - prefIdx * 5);

    eligible.push({
      provider,
      label: agent.label,
      modelId: chosen.modelId,
      tier: chosen.tier,
      effort: chosen.effort,
      sameAsBuilder: stage === "auditing" && builderProvider === provider,
      score,
    });
  }

  eligible.sort((a, b) => b.score - a.score);

  if (eligible.length > 0) {
    const winner = eligible[0];
    const failoverFrom = preferredProvider && preferredProvider !== winner.provider && detectedMap.has(preferredProvider)
      ? preferredProvider
      : null;
    return {
      ok: true,
      skipped: false,
      provider: winner.provider,
      label: winner.label,
      modelId: winner.modelId,
      tier: winner.tier,
      effort: winner.effort,
      sameAsBuilder: winner.sameAsBuilder,
      failoverFrom,
      alternatives: eligible.slice(1).map(c => c.provider),
      policy,
    };
  }

  if (exhaustedWaiters.length > 0) {
    exhaustedWaiters.sort((a, b) => (a.resetAt || Infinity) - (b.resetAt || Infinity));
    const earliest = exhaustedWaiters[0];
    return {
      ok: false,
      code: "QUOTA_WAIT",
      earliestResetAt: earliest.resetAt,
      exhausted: exhaustedWaiters,
      authNeeded,
      policy,
      message: `All ${policy.minTier}+ providers for ${stakes} ${stage} are currently at usage limit. Earliest reset: ${earliest.label}${earliest.resetAt ? ` at ${new Date(earliest.resetAt).toISOString()}` : ""}.`,
    };
  }

  if (authNeeded.length > 0) {
    return {
      ok: false,
      code: "AUTH_REQUIRED",
      authNeeded,
      policy,
      message: `Sign in to ${authNeeded.map(a => a.label).join(" or ")} to run ${stakes} ${stage}.`,
    };
  }

  return {
    ok: false,
    code: "NO_ELIGIBLE_PROVIDER",
    policy,
    message: `No installed CLI meets the ${policy.minTier}+ tier requirement for ${stakes} ${stage}.`,
  };
}

module.exports = {
  PROVIDER_PREFERENCE,
  stagePolicy,
  selectAssignment,
};
