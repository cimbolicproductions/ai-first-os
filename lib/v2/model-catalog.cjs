"use strict";

/**
 * Live Model Discovery, Capability Tier Classification & Safe Canary Promotion.
 *
 * Decouples workflows from stale hardcoded model strings:
 * - Maps discovered models to abstract capability tiers: apex > workhorse > balanced > fast-free
 * - Keeps default flagship selection in the 'workhorse' tier (one notch below apex)
 *   so expensive apex models (e.g. fable / astra) are reserved for explicit escalation
 * - Discovers newer models from installed CLIs, canary-verifies them, and proposes
 *   safe promotion (or auto-promotes only on sandbox when opted in).
 */

const TIERS = Object.freeze(["fast-free", "balanced", "workhorse", "apex"]);
const TIER_RANK = Object.freeze({ "fast-free": 1, balanced: 2, workhorse: 3, apex: 4 });

const PROVIDER_EFFORTS = Object.freeze({
  claude: ["low", "medium", "high", "xhigh"],
  codex: ["low", "medium", "high", "ultra"],
  antigravity: ["low", "medium", "high"],
  gemini: ["low", "medium", "high"],
  cursor: ["medium", "high"],
  opencode: ["low", "medium"],
});

/**
 * Fallback baseline models used only when a CLI does not expose a live listing command.
 * Live CLI discovery supersedes these automatically whenever new models ship.
 */
const SEED_MODELS = Object.freeze([
  // Claude Code
  { provider: "claude", modelId: "claude-opus-5-5", tier: "workhorse" },
  { provider: "claude", modelId: "opus", tier: "workhorse" },
  { provider: "claude", modelId: "sonnet", tier: "balanced" },
  { provider: "claude", modelId: "haiku", tier: "fast-free" },
  // Codex
  { provider: "codex", modelId: "gpt-6.2-sol", tier: "workhorse" },
  { provider: "codex", modelId: "gpt-6.1-sol", tier: "workhorse" },
  { provider: "codex", modelId: "gpt-5.6-sol", tier: "balanced" },
  // Antigravity
  { provider: "antigravity", modelId: "Gemini 3.1 Pro (High)", tier: "workhorse" },
  { provider: "antigravity", modelId: "Gemini 3 Flash", tier: "balanced" },
  // Gemini CLI
  { provider: "gemini", modelId: "gemini-3.1-pro", tier: "workhorse" },
  { provider: "gemini", modelId: "gemini-3-flash", tier: "balanced" },
  // Cursor CLI
  { provider: "cursor", modelId: "default", tier: "balanced" },
  // OpenCode (free)
  { provider: "opencode", modelId: "opencode/deepseek-v4.1-flash-free", tier: "fast-free" },
]);

const SKIP_FREE_MODELS_RE = /big-pickle|mimo|nemotron|exo/i;

/** Extracts a comparable numeric version array from a model string (e.g. "gpt-6.2-sol" -> [6, 2]). */
function extractVersion(modelId) {
  const m = /(\d+)(?:[.-](\d+))?(?:[.-](\d+))?/.exec(String(modelId || ""));
  if (!m) return [0, 0, 0];
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function compareVersions(a, b) {
  const va = extractVersion(a);
  const vb = extractVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return String(a).localeCompare(String(b));
}

/** Classifies any model identifier into apex | workhorse | balanced | fast-free. */
function classifyModelTier(provider, modelId) {
  const id = String(modelId || "").toLowerCase();
  if (!id) return "balanced";

  // Absolute apex / ultra-tier models (kept above default workhorse slot).
  if (/\b(?:fable|astra|apex|o3-pro|o4-pro|pro-max|ultra-max)\b/i.test(id)) return "apex";

  // Free / lightweight / ultra-fast models.
  if (provider === "opencode" || /-free$|\b(?:haiku|flash-lite|nano|mini|deepseek.*free|glm.*free)\b/i.test(id)) {
    return "fast-free";
  }

  // Flagship workhorses just below apex.
  if (/\b(?:opus|sol)\b/i.test(id)) {
    const [major] = extractVersion(id);
    // Older generation sol (e.g., 5.x) drops to balanced once 6.x workhorses exist.
    if (/\bsol\b/i.test(id) && major > 0 && major < 6) return "balanced";
    return "workhorse";
  }
  if (/gemini.*pro/i.test(id) && !/mini|lite/i.test(id)) return "workhorse";

  // Balanced coding tier.
  if (/\b(?:sonnet|flash|gpt-5|gpt-4|codex|composer|default)\b/i.test(id)) return "balanced";

  return "balanced";
}

function parseModelListing(provider, stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const found = [];
  for (const line of lines) {
    if (/^(?:id|model|name|---)/i.test(line)) continue;
    if (provider === "opencode") {
      if (!/^opencode\/[a-z0-9._-]+-free$/i.test(line) || SKIP_FREE_MODELS_RE.test(line)) continue;
      found.push(line);
      continue;
    }
    if (provider === "antigravity") {
      // Tab-separated listing: "<modelId>\t<description>"
      const first = line.split("\t")[0].trim();
      if (first && first.length <= 80) found.push(first);
      continue;
    }
    // Generic CLI listing: first whitespace token if it looks like a model ID.
    const token = line.split(/\s+/)[0];
    if (/^[a-z0-9][a-z0-9._:/-]{1,64}$/i.test(token)) found.push(token);
  }
  return [...new Set(found)];
}

/** Seeds baseline models into SQLite without overriding already-discovered or promoted defaults. */
function seedBaselineModels(store) {
  const existing = store.listModels();
  const byId = new Set(existing.map(m => m.id));
  const defaultsSeen = new Set(existing.filter(m => m.isDefault).map(m => `${m.provider}:${m.tier}`));

  for (const entry of SEED_MODELS) {
    const id = `${entry.provider}:${entry.modelId}`;
    if (byId.has(id)) continue;
    const key = `${entry.provider}:${entry.tier}`;
    const shouldDefault = !defaultsSeen.has(key);
    if (shouldDefault) defaultsSeen.add(key);
    store.upsertModel({
      provider: entry.provider,
      modelId: entry.modelId,
      tier: entry.tier,
      effortLevels: PROVIDER_EFFORTS[entry.provider] || ["medium"],
      status: shouldDefault ? "promoted" : "discovered",
      isDefault: shouldDefault,
    });
  }
}

/**
 * Discovers newly available models from installed CLIs, runs a 1-shot read-only
 * canary probe on newer candidates, and either auto-promotes (if configured for
 * low-stakes tiers) or raises one clean 1-tap promotion card for the owner.
 */
async function refreshModelCatalog({
  store,
  profile,
  providers = [],
  listModelsForProvider = async () => [],
  canaryProbe = async () => ({ ok: true }),
  now = Date.now,
}) {
  seedBaselineModels(store);
  const discoveredNew = [];
  const promoted = [];
  const pendingApprovals = [];

  for (const provider of providers) {
    let rawModels = [];
    try {
      rawModels = await listModelsForProvider(provider);
    } catch {
      continue;
    }
    if (!Array.isArray(rawModels) || !rawModels.length) continue;

    const currentModels = store.listModels({ provider });
    const existingIds = new Set(currentModels.map(m => m.modelId));

    for (const modelId of rawModels) {
      const tier = classifyModelTier(provider, modelId);
      const isNew = !existingIds.has(modelId);
      const saved = store.upsertModel({
        provider,
        modelId,
        tier,
        effortLevels: PROVIDER_EFFORTS[provider] || ["medium"],
        status: isNew ? "discovered" : (currentModels.find(m => m.modelId === modelId)?.status || "discovered"),
        isDefault: Boolean(currentModels.find(m => m.modelId === modelId)?.isDefault),
      });
      if (!isNew) continue;
      discoveredNew.push(saved);

      // Compare against current default for (provider, tier).
      const currentDefault = currentModels.find(m => m.tier === tier && m.isDefault);
      const isUpgrade = !currentDefault || compareVersions(modelId, currentDefault.modelId) > 0;
      if (!isUpgrade) continue;

      // Never auto-promote apex models into default workhorse slots.
      if (tier === "apex" && profile?.models?.preferBelowApex !== false) continue;

      // Canary-verify the new model with a tiny read-only probe before recommending it.
      const probe = await canaryProbe({ provider, modelId }).catch(() => ({ ok: false }));
      if (!probe?.ok) continue;

      store.upsertModel({
        provider,
        modelId,
        tier,
        effortLevels: PROVIDER_EFFORTS[provider] || ["medium"],
        status: "verified",
        isDefault: false,
        verifiedAt: now(),
      });

      const autoPromote = profile?.models?.autoPromoteSandbox === true && (tier === "fast-free" || tier === "balanced");
      if (autoPromote || !currentDefault) {
        promoted.push(store.setDefaultModel(provider, tier, modelId));
      } else {
        // Avoid duplicate open promotion prompts for the same model.
        const open = store.listOpenApprovals({ kind: "model_promotion" });
        const alreadyAsked = open.some(a => a.meta?.provider === provider && a.meta?.modelId === modelId);
        if (!alreadyAsked) {
          const card = store.createApproval({
            kind: "model_promotion",
            title: `New ${provider} model verified`,
            prompt: `${modelId} (${tier} tier) passed verification on ${provider}. Promote it over ${currentDefault.modelId}?`,
            choices: [
              { label: `Use ${modelId}`, value: "promote" },
              { label: `Keep ${currentDefault.modelId}`, value: "keep" },
            ],
            meta: { provider, tier, modelId, previousModelId: currentDefault.modelId },
          });
          pendingApprovals.push(card);
        }
      }
    }
  }

  return { discoveredNew, promoted, pendingApprovals };
}

/**
 * Picks the best model + valid effort level for a given (provider, desiredTier, desiredEffort).
 */
function resolveModelForProvider({ store, profile, provider, desiredTier = "workhorse", desiredEffort = "medium", allowApex = false }) {
  const override = profile?.models?.overrides?.[`${provider}:${desiredTier}`] || profile?.models?.overrides?.[provider] || null;
  const models = store.listModels({ provider }).filter(m => m.status !== "rejected" && m.status !== "retired");
  const filtered = allowApex ? models : models.filter(m => m.tier !== "apex");

  let picked = null;
  if (override) {
    picked = { modelId: override, tier: classifyModelTier(provider, override) };
  } else {
    const exactTier = filtered.filter(m => m.tier === desiredTier);
    const chosenExact = exactTier.find(m => m.isDefault) || exactTier.sort((a, b) => compareVersions(b.modelId, a.modelId))[0];
    if (chosenExact) {
      picked = chosenExact;
    } else {
      // Pick closest available tier on this provider without silently jumping to apex.
      const targetRank = TIER_RANK[desiredTier] || 2;
      const ranked = [...filtered].sort((a, b) => {
        const da = Math.abs((TIER_RANK[a.tier] || 2) - targetRank);
        const db = Math.abs((TIER_RANK[b.tier] || 2) - targetRank);
        if (da !== db) return da - db;
        return (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0);
      });
      picked = ranked[0] || null;
    }
  }

  const supportedEfforts = PROVIDER_EFFORTS[provider] || ["medium"];
  const effort = mapEffortForProvider(provider, desiredEffort, supportedEfforts);
  return {
    modelId: picked?.modelId || null,
    tier: picked?.tier || desiredTier,
    effort,
  };
}

function mapEffortForProvider(provider, desired, supported = PROVIDER_EFFORTS[provider] || ["medium"]) {
  if (supported.includes(desired)) return desired;
  if (desired === "xhigh" && supported.includes("ultra")) return "ultra";
  if (desired === "ultra" && supported.includes("xhigh")) return "xhigh";
  if ((desired === "xhigh" || desired === "ultra") && supported.includes("high")) return "high";
  if (desired === "low" && !supported.includes("low")) return supported[0];
  return supported.includes("medium") ? "medium" : supported[supported.length - 1];
}

module.exports = {
  TIERS,
  TIER_RANK,
  PROVIDER_EFFORTS,
  SEED_MODELS,
  extractVersion,
  compareVersions,
  classifyModelTier,
  parseModelListing,
  seedBaselineModels,
  refreshModelCatalog,
  resolveModelForProvider,
  mapEffortForProvider,
};
