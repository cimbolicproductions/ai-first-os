"use strict";

const path = require("node:path");
const { HARNESSES, PERSONAL_AGENTS, findHarness, labelFor } = require("./harness-registry.cjs");
const { DEFAULT_SLATE, buildRoleSlate } = require("./roles.cjs");
const { hasObsidian, skillsChoices } = require("./vault-options.cjs");

const STATE_WORDS = Object.freeze({ "signed-in": "Signed in", installed: "Not signed in", missing: "Not found" });
const CODER_PREFERENCE = ["claude", "codex", "cursor", "antigravity"];

function suggestCoder(detected) {
  const ready = id => detected.find(a => a.id === id && a.signedIn && a.headless);
  return CODER_PREFERENCE.find(ready) || DEFAULT_SLATE.builder;
}

/** Everything the three windows need, for desktop and terminal alike. */
function buildIntroModel(detected, { workspaceRoot = process.cwd(), options = {} } = {}) {
  const agents = detected.map(a => ({
    id: a.id,
    label: a.label,
    state: a.state,
    stateText: STATE_WORDS[a.state],
    canSignIn: a.state === "installed",
    pickable: a.state === "signed-in",
    models: findHarness(a.id).models,
  }));
  const vaultPath = path.join(workspaceRoot, "ContextVault");
  return {
    orchestrators: [
      ...PERSONAL_AGENTS.map((p, i) => ({ id: p.id, label: p.label, detail: "Personal agent", suggested: i === 0, pickable: true })),
      ...agents.map(a => ({ id: a.id, label: a.label, detail: a.stateText, suggested: false, pickable: a.pickable })),
    ],
    suggestedOrchestrator: DEFAULT_SLATE.orchestrator,
    agents,
    coders: agents.filter(a => a.pickable),
    suggestedCoder: suggestCoder(detected),
    obsidian: hasObsidian(options),
    skills: skillsChoices(vaultPath, options).map(({ id, label }) => ({ id, label })),
  };
}

/** Turns the picks (all optional) into the profile the OS is built from. */
function profileFromIntro(selection = {}, detected = []) {
  const roles = buildRoleSlate({
    orchestrator: selection.orchestrator,
    builder: selection.coder || suggestCoder(detected),
  });
  const known = new Set(HARNESSES.map(h => h.id));
  return {
    userName: "User",
    primaryGoal: "Get work done with connected agents.",
    roles: ["Builder"],
    projects: [],
    workStyle: "single-machine",
    routerName: labelFor(roles.orchestrator),
    roleSlate: roles,
    models: selection.model && known.has(roles.builder) ? { [roles.builder]: selection.model } : {},
    agents: {
      router: labelFor(roles.orchestrator),
      builders: [...new Set([roles.builder, roles.auditor])],
      researchers: [roles.researcher],
    },
    boardMode: "local",
    emptyBoard: true,
    vaultPath: "./ContextVault",
    obsidian: selection.obsidian === true,
    skillsPick: selection.skills || "vault",
    skillsCustomPath: selection.skillsPath || null,
    firstRunComplete: true,
  };
}

/** The same three windows for a person who started from a terminal. */
async function runTerminalIntro({ ask, write, detected, model, onSignIn = () => {} }) {
  write("\n\n      ◯\n\n      Welcome to AI-first OS\n\n");
  await ask("      Press Enter to continue ");

  write("\n  Which one do you want to orchestrate all other agents?\n\n");
  const orchestrators = model.orchestrators.filter(o => o.pickable);
  orchestrators.forEach((o, i) => write(`    ${i + 1}. ${o.label}${o.suggested ? "  (suggested)" : ""}  ${o.detail}\n`));
  const orchestratorAnswer = Number((await ask(`\n  Pick one [1]: `)).trim() || 1);
  const orchestrator = (orchestrators[orchestratorAnswer - 1] || orchestrators[0]).id;

  write("\n  Your agents\n\n");
  for (const agent of model.agents) {
    write(`    ${agent.label.padEnd(14)} ${agent.stateText}\n`);
    if (agent.canSignIn) {
      const yes = (await ask(`    Sign in to ${agent.label}? (y/N): `)).trim().toLowerCase();
      if (yes === "y" || yes === "yes") onSignIn(detected.find(a => a.id === agent.id));
    }
  }

  let coder = model.suggestedCoder;
  if (model.coders.length > 1) {
    write("\n  Your best coding agent\n\n");
    model.coders.forEach((c, i) => write(`    ${i + 1}. ${c.label}\n`));
    const fallback = Math.max(0, model.coders.findIndex(c => c.id === coder)) + 1;
    const picked = Number((await ask(`\n  Pick one [${fallback}]: `)).trim() || fallback);
    coder = (model.coders[picked - 1] || model.coders[fallback - 1]).id;
  }

  let chosenModel = null;
  const models = findHarness(coder)?.models || [];
  if (models.length > 1) {
    write(`\n  Which model should ${labelFor(coder)} use?\n\n`);
    models.forEach((m, i) => write(`    ${i + 1}. ${m.label}\n`));
    const picked = Number((await ask(`\n  Pick one [1]: `)).trim() || 1);
    chosenModel = (models[picked - 1] || models[0]).id;
  }

  let obsidian = false;
  if (model.obsidian) {
    const yes = (await ask("\n  Keep your notes in Obsidian? (y/N): ")).trim().toLowerCase();
    obsidian = yes === "y" || yes === "yes";
  }
  return { orchestrator, coder, model: chosenModel, obsidian };
}

module.exports = { buildIntroModel, profileFromIntro, runTerminalIntro, suggestCoder, STATE_WORDS };
