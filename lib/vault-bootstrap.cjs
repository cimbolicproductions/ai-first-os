"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { renderOperatingConstitution, renderAgentInstructions } = require("./ideology.cjs");

const CORE_FOLDERS = [
  "00_Inbox/Brain_Dumps",
  "00_Inbox/Raw_Captures",
  "00_Inbox/To_Process",
  "01_Command_Center",
  "01_Command_Center/Daily",
  "01_Command_Center/Weekly",
  "02_Self_Context/Profile",
  "02_Self_Context/Preferences",
  "02_Self_Context/Decision_Principles",
  "04_Projects/Active",
  "04_Projects/Backlog",
  "04_Projects/Paused",
  "04_Projects/Completed",
  "05_Knowledge_Base/People",
  "05_Knowledge_Base/Tools",
  "05_Knowledge_Base/Concepts",
  "06_AI_Context/Handoffs",
  "06_AI_Context/Reusable_Prompts",
  "07_Decisions_and_Lessons/Decision_Log",
  "07_Decisions_and_Lessons/Lessons_Learned",
  "07_Decisions_and_Lessons/Failure_Modes",
  "08_Systems_and_SOPs/Checklists",
  "08_Systems_and_SOPs/Automations",
  "08_Systems_and_SOPs/Templates",
  "08_Systems_and_SOPs/Skills",
  "09_Archive",
];

const OPTIONAL_FOLDER_MODULES = {
  business: [
    "03_Work_and_Business/Businesses",
    "03_Work_and_Business/Offers",
    "03_Work_and_Business/Customers",
    "03_Work_and_Business/Sales_and_Marketing",
    "03_Work_and_Business/Operations",
    "03_Work_and_Business/Finance",
  ],
  feedback: [
    "Feedback/_INBOX",
  ],
  research: [
    "05_Knowledge_Base/Companies",
    "05_Knowledge_Base/Research_Notes",
    "Transcripts",
  ],
  career: [
    "01_Command_Center/Career",
    "04_Projects/Active/Career_Pipeline",
  ],
};

function resolveFolderList(profile = {}) {
  const list = [...CORE_FOLDERS];
  const modules = new Set(profile.modules || []);
  if (profile.hasBusinesses) {
    modules.add("business");
    modules.add("feedback");
  }
  if (profile.hasResearch) modules.add("research");
  if (profile.hasCareer) modules.add("career");

  for (const mod of modules) {
    for (const folder of OPTIONAL_FOLDER_MODULES[mod] || []) {
      if (!list.includes(folder)) list.push(folder);
    }
  }
  if (modules.has("feedback") && Array.isArray(profile.projects)) {
    for (const proj of profile.projects) {
      const slug = String(proj.name || proj).trim().replace(/[^A-Za-z0-9_-]+/g, "_");
      if (slug) list.push(`Feedback/${slug}`);
    }
  }
  return list;
}

function buildTemplates(profile, dateStr) {
  const userName = profile.userName || "Operator";
  const roles = (profile.roles || ["Builder"]).join(", ");
  const prefs = (profile.preferences || ["Concise, direct answers", "Evidence and code before prose"]).map(p => `- ${p}`).join("\n");
  const projectsList = (profile.projects || []).map(p => `- **${p.name || p}** (${p.goal || "active"})`).join("\n") || "- (Add your top 1-2 active projects)";

  return {
    "01_Command_Center/README.md": `# Command Center — ${userName}

Updated: ${dateStr}

## What Deserves Attention Right Now
*Rule: At most 2 discretionary experiments active at once, ranked by leverage.*

${projectsList}

## This Week's Non-Negotiables
${(profile.constraints || ["Protect family / deep-work boundaries", "Verify before any external send or spend"]).map(c => `- ${c}`).join("\n")}

## Open Loops (Route from 00_Inbox)
- [ ] Run \`node bin/aios.cjs doctor\` to verify all connected AI services, task board, and tools
`,
    "02_Self_Context/Profile/user-profile.md": `# User Profile

## Identity
- Name: ${userName}
- Timezone: ${profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
- Roles: ${roles}
- Work Mode: ${profile.workStyle || "hybrid (desktop + phone/remote)"}

## Primary Priority
${profile.primaryGoal || "Ship high-leverage work with minimal coordination overhead."}

## What AI Should Always Respect
${prefs}

## Hard Boundaries (Never Cross Without Explicit Yes)
- Any spend of any amount
- Sending external emails, texts, or messages
- Publishing live listings or store submissions
- Refunds or billing changes
`,
    "04_Projects/project-template.md": `# Project: {{name}}

## One-Sentence Goal

## Bottleneck (Demand / Distribution / Conversion / Activation / Operations / Unknown)

## Current Status
- Stage: proposed | active | paused | done
- Last updated: ${dateStr}
- Owner:

## Hypothesis & Acceptance Check

## Constraints & Budget

## Next Actions
- [ ]
`,
    "00_Inbox/Brain_Dumps/brain-dump-template.md": `# Brain Dump - ${dateStr}

*Rule: A brain dump is uncommitted capture, not an execution command. Extract ideas first; promote only bounded commitments.*

## Raw Capture

## Candidate Ideas vs. Operational Obligations

## Proposed Board Rows (for ${profile.routerName || "Router"} to rank)
`,
    "06_AI_Context/Handoffs/ai-handoff-template.md": `# HANDOFF: {{title}}

Status: proposal, no board row yet. ${profile.routerName || "Router"} ranks and assigns.
Proposed owner:

## One Line

## What It Keeps Unchanged

## Acceptance Checks
1.

## Open Questions for ${userName}
1.
`,
    "07_Decisions_and_Lessons/Decision_Log/decision-template.md": `# Decision - ${dateStr} - {{title}}

## Decision

## Evidence Available at the Time

## Options Considered (Including "Do Nothing")

## Prediction & Review Date

## Actual Outcome (Fill In Later)
`,
    "08_Systems_and_SOPs/Templates/snagticket-template.md": `# Snag Ticket - {{title}}

## Symptom

## Exact Reproduction / Where It Happens

## Root Cause (Measured, Not Guessed)

## Guard / Fix Applied
`,
    "08_Systems_and_SOPs/OPERATING_CONSTITUTION.md": renderOperatingConstitution(profile),
  };
}

function buildStarterSkills() {
  return {
    "08_Systems_and_SOPs/Skills/vault-ingestion-router.md": `# Skill: Vault Ingestion Router

When raw notes, voice dumps, screenshots, or links arrive:
1. Never treat a raw brainstorm as an immediate build command.
2. File raw customer/market feedback verbatim under \`Feedback/<Project>/\`.
3. File durable lessons or decisions under \`07_Decisions_and_Lessons/\`.
4. File project updates under \`04_Projects/Active/<project>.md\`.
5. If unclear, place in \`00_Inbox/To_Process/\` with a review date.
`,
    "08_Systems_and_SOPs/Skills/personal-os-review.md": `# Skill: Weekly Operating Review

Every week, answer three questions from real evidence:
1. **What deserves my attention right now?** (Highest leverage per scarce hour)
2. **What should happen next?** (At most 2 active discretionary experiments)
3. **What should we stop?** (Pause or archive work that is producing tasks instead of results)
`,
  };
}

function bootstrapVault(vaultPath, profile = {}) {
  const root = path.resolve(vaultPath);
  const dateStr = profile.date || new Date().toISOString().slice(0, 10);
  const folders = resolveFolderList(profile);

  fs.mkdirSync(root, { recursive: true });
  for (const rel of folders) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }

  const filesWritten = [];
  const templates = { ...buildTemplates(profile, dateStr), ...buildStarterSkills() };

  for (const [rel, content] of Object.entries(templates)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content, "utf8");
      filesWritten.push(rel);
    }
  }

  // Create starter active project notes from the user's interview answers
  for (const proj of profile.projects || []) {
    const name = typeof proj === "string" ? proj : proj.name;
    if (!name) continue;
    const slug = name.trim().replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase();
    const rel = `04_Projects/Active/${slug}.md`;
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) {
      const goal = typeof proj === "object" && proj.goal ? proj.goal : "Define primary bottleneck and next measurable test.";
      fs.writeFileSync(
        target,
        `# Project: ${name}\n\n## One-Sentence Goal\n${goal}\n\n## Current Status\n- Stage: active\n- Last updated: ${dateStr}\n- Owner: ${profile.routerName || "Router"}\n\n## Next Actions\n- [ ] Identify current bottleneck (demand, distribution, conversion, or operations)\n`,
        "utf8"
      );
      filesWritten.push(rel);
    }
  }

  // Write agent instruction files in 06_AI_Context
  const agentRoles = [
    ...(profile.agents?.builders || ["claude", "codex"]).map(a => [a, "build"]),
    ...(profile.agents?.researchers || ["gemini"]).map(a => [a, "research"]),
  ];
  for (const [agentName, role] of agentRoles) {
    const rel = `06_AI_Context/${agentName.toUpperCase()}.md`;
    const target = path.join(root, rel);
    fs.writeFileSync(target, renderAgentInstructions({ agentName, role, profile, vaultPath: root }), "utf8");
    filesWritten.push(rel);
  }

  const indexTarget = path.join(root, "VAULT_INDEX.md");
  fs.writeFileSync(
    indexTarget,
    `# Personal Context Vault Index

Created: ${dateStr}
Owner: ${profile.userName || "Operator"}

## Start Here
- \`01_Command_Center/README.md\` — Current priorities & weekly focus
- \`02_Self_Context/Profile/user-profile.md\` — Identity, roles, and AI boundaries
- \`08_Systems_and_SOPs/OPERATING_CONSTITUTION.md\` — Core operating rules & approval gates
- \`06_AI_Context/Handoffs/ai-handoff-template.md\` — Standard agent work-order handoff

## Active Folders Created for Your Profile
${folders.map(f => `- \`${f}/\``).join("\n")}
`,
    "utf8"
  );
  filesWritten.push("VAULT_INDEX.md");

  return { root, foldersCreated: folders, filesWritten };
}

module.exports = {
  CORE_FOLDERS,
  OPTIONAL_FOLDER_MODULES,
  resolveFolderList,
  bootstrapVault,
};
