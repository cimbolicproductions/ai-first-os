"use strict";

const { HARNESSES, findHarness, findPersonalAgent, labelFor } = require("./harness-registry.cjs");

/**
 * Roles are mapped to roles, not to products. The slate below works with zero
 * configuration; every entry can be overridden, and routing falls through to any
 * available agent rather than stalling.
 */
const DEFAULT_SLATE = Object.freeze({
  orchestrator: "muse",
  builder: "claude",
  auditor: "codex",
  researcher: "gemini",
});

const ROLE_TO_CAPABILITY = Object.freeze({
  orchestrator: "organize",
  builder: "build",
  auditor: "audit",
  researcher: "research",
});

function canonicalId(id) {
  return findHarness(id)?.id || String(id || "").toLowerCase();
}

/** The audit pairing is symmetric: whoever builds, the other audits. */
function buildRoleSlate(picks = {}) {
  const builder = canonicalId(picks.builder || DEFAULT_SLATE.builder);
  let auditor = canonicalId(picks.auditor || "");
  if (!auditor) {
    auditor = builder === "codex" ? "claude" : builder === "claude" ? "codex" : DEFAULT_SLATE.builder;
  }
  return {
    orchestrator: String(picks.orchestrator || DEFAULT_SLATE.orchestrator).toLowerCase(),
    builder,
    auditor,
    researcher: canonicalId(picks.researcher || DEFAULT_SLATE.researcher),
  };
}

function availabilityFromDetected(detected = []) {
  const map = {};
  for (const agent of detected) {
    map[agent.id] = Boolean(agent.installed && agent.signedIn && agent.headless);
  }
  return map;
}

function roleOfAgent(agentId, manifest) {
  const id = canonicalId(agentId);
  const roles = manifest?.roles || {};
  for (const [role, holder] of Object.entries(roles)) {
    if (canonicalId(holder) === id) return role;
  }
  const declared = manifest?.agents?.[id]?.role;
  if (declared === "build") return "builder";
  if (declared === "research") return "researcher";
  if (declared === "organize") return "orchestrator";
  if (findPersonalAgent(id)) return "orchestrator";
  const spec = findHarness(id);
  if (spec) return spec.defaultRole === "research" ? "researcher" : "builder";
  if (String(manifest?.ideology?.routerFunnel || "").toLowerCase() === id) return "orchestrator";
  return "builder";
}

/** Order of who should take a role: holder, then partner, then anyone capable. */
function candidatesForRole(role, manifest) {
  const roles = manifest?.roles || {};
  const capability = ROLE_TO_CAPABILITY[role] || "build";
  // The owner's first and second choice for this role come before anything else.
  const picks = Array.isArray(manifest?.priorities?.[role]) ? manifest.priorities[role] : [];
  const ordered = [...picks, roles[role]];
  if (role === "auditor") ordered.push(roles.builder);
  if (role === "builder") ordered.push(roles.auditor);
  if (role === "researcher" || role === "orchestrator") ordered.push(roles.builder, roles.auditor);
  ordered.push(...HARNESSES.filter(h => h.roles.includes(capability)).map(h => h.id));
  ordered.push(...HARNESSES.map(h => h.id));
  return [...new Set(ordered.filter(Boolean).map(canonicalId))];
}

function routeTask({ assigned, manifest, availability, exclude = [], role: knownRole = null }) {
  const wanted = canonicalId(assigned);
  const blocked = new Set(exclude.map(canonicalId));
  const role = knownRole || roleOfAgent(wanted, manifest);
  if (availability[wanted] && !blocked.has(wanted)) {
    return { agent: wanted, substitutedFrom: null, role };
  }
  const pick = candidatesForRole(role, manifest).find(id => availability[id] && !blocked.has(id));
  if (!pick) {
    return { agent: null, substitutedFrom: null, role, reason: `No signed-in agent can take this for ${labelFor(wanted)}.` };
  }
  return {
    agent: pick,
    substitutedFrom: wanted,
    role,
    note: `${labelFor(wanted)} is not available, so ${labelFor(pick)} took this.`,
  };
}

/** Prefers the partner of whoever built, and only falls back to the builder itself. */
function pickAuditor({ builder, manifest, availability }) {
  const who = canonicalId(builder);
  const roles = manifest?.roles || {};
  const preferred = canonicalId(roles.auditor) === who ? canonicalId(roles.builder) : canonicalId(roles.auditor);
  const order = [preferred, ...candidatesForRole("auditor", manifest)].filter(id => id && id !== who);
  const other = order.find(id => availability[id]);
  if (other) return { agent: other, sameAsBuilder: false };
  if (availability[who]) return { agent: who, sameAsBuilder: true };
  return { agent: null, sameAsBuilder: false };
}

module.exports = {
  DEFAULT_SLATE,
  canonicalId,
  buildRoleSlate,
  availabilityFromDetected,
  roleOfAgent,
  candidatesForRole,
  routeTask,
  pickAuditor,
};
