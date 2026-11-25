"use strict";

const path = require("node:path");
const { listAllProjects, resolveProject, stakesForProject, mergePolicyForProject, createManagedProject } = require("./profile.cjs");
const { selectAssignment } = require("./router.cjs");
const { runHarness, detectHarnesses } = require("./harnesses.cjs");
const { recordProviderFailure, recordProviderSuccess } = require("./quota.cjs");
const { prepareWorktree, snapshotWorktree, commitWorktree, mergeBranchIntoRepo, removeWorktree, createProjectLockManager } = require("./worktree.cjs");
const { createRunSpace, syncDeliveryToVault } = require("./agent-bus.cjs");

/**
 * Adaptive 3-Stage Terminal Pipeline & Agent-to-Agent Collaboration Engine.
 *
 * One task stays ONE thread with ONE run directory (~/.aios/runs/<taskId>/):
 *   Intake -> Plan (Workhorse) -> Build (Stakes-Matched Worktree)
 *          <-> Builder/Planner Bus Clarification (bounded, no human interruption)
 *          -> Audit (Distinct Workhorse reading real diff.patch + test.log)
 *          <-> Bounded Fix Loop (auto-escalating tier if needed)
 *          -> Total Output Delivery Card (+ per-repo merge policy)
 */

const MAX_AUDIT_ROUNDS = 3;
const MAX_PLAN_CLARIFICATIONS = 2;
const MAX_FAILOVER_ATTEMPTS = 6;

const HARD_GATE_RE = /(?:^|[.!?;]\s+|\b(?:and|then)\s+)(?:please\s+)?(?:send an? (?:email|text|sms|message)|email |text |publish |submit |refund |buy |purchase |charge |deploy to production|push to prod)/i;

/** Detects when natural user input refers to continuing an existing active/paused task. */
function matchContinuationTarget(store, text) {
  const clean = String(text || "").trim();
  const explicit = /^(?:please\s+)?(?:continue|resume|keep going(?: on| with)?|finish)\s+(T\d+|P\d+)\b/i.exec(clean);
  if (explicit) {
    const task = store.getTask(explicit[1].toUpperCase());
    if (task && !task.putAway && task.status !== "done") return task;
  }
  if (/^(?:please\s+)?(?:continue|resume|keep going)\b/i.test(clean)) {
    const candidates = store.listTasks().filter(t => t.status === "waiting" || t.status === "failed");
    if (candidates.length === 1) return candidates[0];
    const lower = clean.toLowerCase();
    const matched = candidates.filter(t =>
      (t.projectName && lower.includes(t.projectName.toLowerCase())) ||
      t.title.toLowerCase().split(/\s+/).filter(w => w.length >= 4).some(w => lower.includes(w))
    );
    if (matched.length === 1) return matched[0];
  }
  return null;
}

function buildIntakePrompt({ task, thread, projects, resultFile }) {
  const projectList = projects.slice(0, 50).map(p => `- ${p.name} [stakes: ${p.stakes}]${p.repo ? ` (${p.repo})` : ""}`).join("\n") || "- none yet";
  const convo = thread.map(m => `[${m.role}] ${m.content}`).join("\n");
  return [
    `# AI-first OS Intake — Task ${task.id}`,
    `You are the intake organizer. Your job is to understand the owner's intent cleanly, ask only essential missing questions to reach the core of the idea, or produce a locked brief for the Planner.`,
    ``,
    `## Known Projects`,
    projectList,
    ``,
    `## Conversation Thread`,
    convo,
    ``,
    `## Rules`,
    `- Do NOT edit any repository files. Read-only intake only.`,
    `- If the user asked a simple question, return status "answer".`,
    `- If critical details are missing (what it is for, who uses it, what finished looks like, or which project), return status "clarify" with 1-4 crisp questions. If the user says "you decide", stop asking and make smart concrete choices.`,
    `- If the request directly orders a hard-gated external action (spending money, sending messages/emails to others, public submission, billing/refund), return status "approval_required". Describing what an app feature will do ("users can pay with Stripe") is NOT a spend action.`,
    `- Once the picture is clear, return status "brief_ready" with a structured brief.`,
    `- Write your JSON output to "${resultFile}" (or print AIOS-RESULT: <json> on its own line):`,
    `  {"status":"answer","title":"...","answer":"..."}`,
    `  {"status":"clarify","title":"...","question":"..."}`,
    `  {"status":"approval_required","title":"...","action":"..."}`,
    `  {"status":"needs_auth","service":"github|vercel|stripe|...","reason":"..."}`,
    `  {"status":"brief_ready","title":"...","project":"existing-name-or-null","newProject":"slug-if-brand-new-or-null","complexity":"trivial|normal|complex","summary":"...","requirements":["..."],"nonGoals":["..."],"acceptanceChecks":["..."],"verificationCommands":["..."],"referenceFiles":["..."]}`,
  ].join("\n");
}

function buildPlannerPrompt({ task, brief, busHistory, resultFile, clarificationQuestion = null }) {
  const lines = [
    `# AI-first OS Architect / Planner — Task ${task.id}`,
    `Project: ${task.projectName || "workspace"} (Stakes: ${task.stakes})`,
    ``,
    `## Locked Brief`,
    JSON.stringify(brief, null, 2),
  ];
  if (busHistory.length) {
    lines.push("", "## Agent Bus History", JSON.stringify(busHistory.slice(-12), null, 2));
  }
  if (clarificationQuestion) {
    lines.push(
      "",
      "## Builder Clarification Request",
      clarificationQuestion,
      `Answer the builder's question concisely and concretely so it can finish without ambiguity.`,
      `Write JSON to "${resultFile}" (or AIOS-RESULT: <json>):`,
      `{"status":"plan_answer","answer":"...","planAddendum":"optional extra steps"}`
    );
  } else {
    lines.push(
      "",
      "## Instructions",
      `- Inspect the repository in read-only mode. Do NOT edit files.`,
      `- Produce a thorough, unambiguous implementation plan that a faster/cheaper builder can execute deterministically.`,
      `- Include exact file paths, data shapes, edge cases, and verification commands.`,
      `- Write JSON to "${resultFile}" (or AIOS-RESULT: <json>):`,
      `{"status":"plan_ready","planMarkdown":"# Plan\\n...","verificationCommands":["npm test"],"needsAuthService":null}`
    );
  }
  return lines.join("\n");
}

function buildBuilderPrompt({ task, brief, planMarkdown, busHistory, auditFindings = null, stagedRefs = [], resultFile }) {
  const lines = [
    `# AI-first OS Builder — Task ${task.id}${auditFindings ? ` (Fix Round ${task.auditRound})` : ""}`,
    `Project: ${task.projectName || "workspace"} | Stakes: ${task.stakes} | Branch: ${task.branch || "isolated"}`,
    `You are working inside an ISOLATED git worktree. Edit files freely inside this worktree and run local verification.`,
    `Hard stops (NEVER execute): spending money, buying domains, sending emails/SMS, public publishing, or billing mutations.`,
    ``,
    `## Locked Brief`,
    JSON.stringify(brief, null, 2),
    ``,
    `## Implementation Plan`,
    planMarkdown || "(Execute the locked brief directly.)",
  ];
  if (stagedRefs.length) {
    lines.push("", "## Staged Read-Only Reference Files (safe to read locally)", ...stagedRefs.map(r => `- ${r.stagedPath} (from ${r.source})`));
  }
  if (auditFindings?.length) {
    lines.push(
      "",
      "## Cross-Model Audit Findings To Fix",
      ...auditFindings.map((f, i) => `${i + 1}. [${f.severity || "issue"}] ${f.file ? `${f.file}${f.line ? ":" + f.line : ""} — ` : ""}${f.detail}${f.suggestedFix ? ` (Suggested: ${f.suggestedFix})` : ""}`),
      `Fix every listed issue without breaking passing functionality.`
    );
  }
  if (busHistory.length) {
    lines.push("", "## Agent Bus Messages", JSON.stringify(busHistory.slice(-10), null, 2));
  }
  lines.push(
    "",
    "## Output Contract",
    `- If the plan has a genuine technical ambiguity you need the Planner to resolve, write status "clarify_plan" with "question" (do NOT guess on critical logic).`,
    `- If you need an unconnected external service or expired auth to continue, write status "needs_auth" with "service" and "reason".`,
    `- If blocked by something you cannot fix, write status "blocked" with "summary" (NEVER claim completed when blocked).`,
    `- When implemented and verified, write JSON to "${resultFile}" (or AIOS-RESULT: <json>):`,
    `{"status":"completed","summary":"Plain summary of what was built and verified","testsRun":["..."],"testsPassed":true,"previewUrl":null}`
  );
  return lines.join("\n");
}

function buildAuditorPrompt({ task, brief, planMarkdown, snapshot, testLog, resultFile }) {
  return [
    `# AI-first OS Independent Auditor — Task ${task.id} (Round ${task.auditRound + 1})`,
    `Project: ${task.projectName || "workspace"} | Stakes: ${task.stakes} | Built by: ${task.builderAgent}`,
    `Do NOT modify any files. You are checking another agent's work objectively against the brief, plan, and ground-truth diff.`,
    ``,
    `## Locked Brief`,
    JSON.stringify(brief, null, 2),
    ``,
    `## Plan`,
    planMarkdown || "(No separate plan)",
    ``,
    `## Ground-Truth Changed Files`,
    snapshot.changedFiles.length ? snapshot.changedFiles.map(f => `- ${f}`).join("\n") : "- (NO FILES CHANGED)",
    ``,
    `## Ground-Truth Git Diff`,
    "```diff",
    snapshot.diff || "(empty diff)",
    "```",
    ...(testLog ? ["", "## Verification Log", "```", testLog.slice(-6000), "```"] : []),
    ``,
    `## Output Contract`,
    `- Only report real bugs, missing requirements, security holes, or broken tests.`,
    `- Write JSON to "${resultFile}" (or AIOS-RESULT: <json>):`,
    `  Clean:    {"status":"clean","summary":"What holds up and why it is ready"}`,
    `  Findings: {"status":"findings","summary":"Short overview","findings":[{"file":"path","line":12,"severity":"high|medium|low","detail":"Exact problem","suggestedFix":"How to fix"}]}`,
  ].join("\n");
}

function createPipeline({
  store,
  getProfile,
  profileDir,
  runsDir,
  worktreesDir,
  authBroker = null,
  detect = detectHarnesses,
  runner = runHarness,
  runVerification = null,
  onEvent = () => {},
  now = Date.now,
}) {
  const locks = createProjectLockManager();
  const activeControllers = new Map();

  function emit(type, payload) {
    try { onEvent({ type, at: now(), ...payload }); } catch { /* never break pipeline */ }
  }

  function postBus(runSpace, taskId, fromAgent, toAgent, msgType, payload) {
    const entry = store.addBusMessage({ taskId, fromAgent, toAgent, msgType, payload });
    runSpace.appendBus({ fromAgent, toAgent, msgType, payload });
    emit("bus", { taskId, fromAgent, toAgent, msgType });
    return entry;
  }

  function stepTitleFor(stage, auditRound = 0) {
    if (stage === "intake") return "Understanding request";
    if (stage === "planning") return "Planning architecture";
    if (stage === "worktree") return "Preparing isolated worktree";
    if (stage === "building") return "Building implementation";
    if (stage === "fixing") return `Applying audit fixes${auditRound ? ` (round ${auditRound})` : ""}`;
    if (stage === "auditing") return `Cross-model review${auditRound ? ` (round ${auditRound + 1})` : ""}`;
    if (stage === "clarifying") return "Consulting planner";
    if (stage === "verifying") return "Running verification checks";
    if (stage === "shipping") return "Preparing Total Output";
    return stage;
  }

  function recordStep(runSpace, taskId, patch) {
    const steps = runSpace.upsertStep({ ...patch, at: now() });
    emit("step_updated", { taskId, stepId: patch.id || patch.stage, steps });
    return steps;
  }

  /**
   * Executes one pipeline stage with automatic quota failover across ALL eligible
   * subscriptions that meet the stakes intelligence floor.
   */
  async function executeStageWithFailover({
    task,
    stage,
    stepId = null,
    stepTitle = null,
    promptBuilder,
    cwd,
    runSpace,
    mode,
    complexity = "normal",
    preferredProvider = null,
    builderProvider = null,
    signal,
  }) {
    const profile = getProfile();
    const excludeProviders = [];
    const activeStepId = stepId || (stage === "auditing" || stage === "fixing" ? `${stage}-${task.auditRound + 1}` : stage);
    const activeStepTitle = stepTitle || stepTitleFor(stage, task.auditRound);

    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      const detected = detect({ workspaceRoot: cwd });
      const assignment = selectAssignment({
        store,
        profile,
        detected,
        stakes: task.stakes,
        stage,
        complexity,
        escalationLevel: task.escalationLevel,
        preferredProvider: attempt === 0 ? preferredProvider : null,
        builderProvider,
        excludeProviders,
        now: now(),
      });

      if (!assignment.ok) {
        recordStep(runSpace, task.id, {
          id: activeStepId,
          stage,
          title: activeStepTitle,
          status: "failed",
          detail: assignment.message,
        });
        return { ok: false, assignment };
      }
      if (assignment.skipped) {
        recordStep(runSpace, task.id, {
          id: activeStepId,
          stage,
          title: activeStepTitle,
          status: "skipped",
          detail: assignment.reason || "Skipped for trivial change",
        });
        return { ok: true, skipped: true, assignment };
      }

      const detailLine = `${assignment.label} · ${assignment.modelId || assignment.tier}`;
      store.updateTask(task.id, {
        stage,
        assignedAgent: assignment.provider,
        assignedModel: assignment.modelId,
        assignedEffort: assignment.effort,
        lastActivity: `${activeStepTitle} (${detailLine})`,
        lastActivityAt: now(),
      });
      recordStep(runSpace, task.id, {
        id: activeStepId,
        stage,
        title: activeStepTitle,
        agent: assignment.label,
        model: assignment.modelId || assignment.tier,
        effort: assignment.effort,
        status: "in_progress",
        detail: assignment.failoverFrom ? `Switched to ${assignment.label}` : detailLine,
        activity: assignment.failoverFrom ? `Failover from ${assignment.failoverFrom} -> ${assignment.label}` : null,
      });
      emit("stage_started", {
        taskId: task.id,
        stage,
        stepId: activeStepId,
        provider: assignment.provider,
        label: assignment.label,
        modelId: assignment.modelId,
        effort: assignment.effort,
        failoverFrom: assignment.failoverFrom,
      });

      const resultFile = runSpace.clearStageResult();
      const prompt = promptBuilder({ resultFile, assignment });
      const ran = await runner({
        provider: assignment.provider,
        prompt,
        cwd,
        runDir: runSpace.dir,
        resultFile,
        mode,
        model: assignment.modelId,
        effort: assignment.effort,
        detect,
        signal,
        onActivity(words) {
          store.updateTask(task.id, { lastActivity: words, lastActivityAt: now() });
          const steps = runSpace.upsertStep({
            id: activeStepId,
            stage,
            title: activeStepTitle,
            agent: assignment.label,
            model: assignment.modelId || assignment.tier,
            status: "in_progress",
            detail: words,
            activity: words,
            at: now(),
          });
          emit("activity", { taskId: task.id, stepId: activeStepId, provider: assignment.provider, text: words, steps });
        },
      });

      if (!ran.ok) {
        const failure = ran.failure || { kind: "error", provider: assignment.provider, reason: "Run failed" };
        if (failure.kind === "exhausted") {
          recordProviderFailure(store, failure);
          excludeProviders.push(assignment.provider);
          recordStep(runSpace, task.id, {
            id: activeStepId,
            stage,
            title: activeStepTitle,
            status: "in_progress",
            detail: `${assignment.label} hit usage limit · switching…`,
            activity: `${assignment.label} hit usage limit — failing over`,
          });
          store.addThreadMessage({
            taskId: task.id,
            role: "system",
            kind: "status",
            content: `${assignment.label} hit its usage limit. Failing over to next eligible subscription.`,
          });
          continue;
        }
        if (failure.kind === "auth_expired") {
          recordProviderFailure(store, failure);
          excludeProviders.push(assignment.provider);
          recordStep(runSpace, task.id, {
            id: activeStepId,
            stage,
            title: activeStepTitle,
            status: "in_progress",
            detail: `${assignment.label} needs sign-in · trying next subscription…`,
            activity: `${assignment.label} sign-in expired — sending sign-in link`,
          });
          if (authBroker) {
            await authBroker.requestAuth({
              taskId: task.id,
              service: assignment.provider,
              reason: `${assignment.label} sign-in expired.`,
            }).catch(() => {});
          }
          // Try another eligible subscription first; if none remain, router returns AUTH_REQUIRED!
          continue;
        }
        if (failure.kind === "model_unsupported") {
          excludeProviders.push(assignment.provider);
          continue;
        }
        recordStep(runSpace, task.id, {
          id: activeStepId,
          stage,
          title: activeStepTitle,
          status: "failed",
          detail: failure.reason || "Stage failed",
        });
        return { ok: false, assignment, runError: failure.reason || ran.stderr || "Agent run failed." };
      }

      recordProviderSuccess(store, assignment.provider);
      recordStep(runSpace, task.id, {
        id: activeStepId,
        stage,
        title: activeStepTitle,
        agent: assignment.label,
        model: assignment.modelId || assignment.tier,
        effort: assignment.effort,
        status: "done",
        detail: `${assignment.label} · ${assignment.modelId || assignment.tier}`,
      });
      return { ok: true, assignment, ran };
    }

    return { ok: false, assignment: { ok: false, code: "EXHAUSTED_ATTEMPTS", message: "All failover attempts were exhausted." } };
  }

  function handleUnroutable(task, assignment) {
    if (assignment.code === "QUOTA_WAIT") {
      store.updateTask(task.id, {
        status: "waiting",
        stage: "waiting_quota",
        retryAfter: assignment.earliestResetAt || (now() + 15 * 60 * 1000),
        errorText: assignment.message,
      });
      store.addThreadMessage({ taskId: task.id, role: "system", kind: "status", content: assignment.message });
      return { status: "waiting_quota", task: store.getTask(task.id) };
    }
    if (assignment.code === "AUTH_REQUIRED") {
      const target = assignment.authNeeded?.[0];
      store.updateTask(task.id, { status: "waiting", stage: "waiting_auth", errorText: assignment.message });
      store.addThreadMessage({ taskId: task.id, role: "system", kind: "status", content: assignment.message });
      if (authBroker && target) {
        authBroker.requestAuth({ taskId: task.id, service: target.provider, reason: assignment.message }).catch(() => {});
      }
      return { status: "waiting_auth", task: store.getTask(task.id) };
    }
    store.updateTask(task.id, { status: "failed", stage: "failed", errorText: assignment.message });
    store.addThreadMessage({ taskId: task.id, role: "system", kind: "error", content: assignment.message });
    return { status: "failed", task: store.getTask(task.id) };
  }

  async function processTask(taskId) {
    let task = store.getTask(taskId);
    if (!task || task.status !== "open" || task.putAway) return { ran: false, reason: "NOT_OPEN" };
    if (store.getQueueState().paused) return { ran: false, reason: "QUEUE_PAUSED" };

    // Acquire per-project lock so unrelated repos run in parallel while same repo serializes.
    const lockKey = task.projectPath || task.projectName || `task:${task.id}`;
    const releaseLock = locks.tryAcquire(lockKey, task.id);
    if (!releaseLock) return { ran: false, reason: "PROJECT_BUSY" };

    const controller = new AbortController();
    activeControllers.set(task.id, controller);
    const runSpace = createRunSpace({ runsDir, taskId: task.id });
    const agentsUsed = [];
    const noteAgent = (stage, a) => {
      const tag = `${stage}:${a.label}(${a.modelId || a.tier}/${a.effort})`;
      if (!agentsUsed.includes(tag)) agentsUsed.push(tag);
    };

    try {
      store.claimTask(task.id, { agent: task.assignedAgent || "router", stage: task.stage });
      task = store.getTask(task.id);
      const profile = getProfile();
      const projects = listAllProjects(profile);

      // --- STAGE 1: INTAKE (skipped if locked brief already supplied by Muse/GrokBot) ---
      if (task.stage === "intake" && !task.brief) {
        if (HARD_GATE_RE.test(task.originalText)) {
          const card = store.createApproval({
            taskId: task.id,
            kind: "approval",
            title: "External action approval",
            prompt: `Approve this gated request before any agent acts?\n\n${task.originalText.slice(0, 1200)}`,
            choices: [{ label: "Approve", value: "yes" }, { label: "Cancel", value: "no" }],
            meta: { type: "hard_gate" },
          });
          store.updateTask(task.id, { status: "waiting", stage: "waiting_approval" });
          return { ran: true, status: "waiting_approval", approval: card };
        }

        const intakeRes = await executeStageWithFailover({
          task,
          stage: "intake",
          cwd: task.projectPath || profileDir,
          runSpace,
          mode: "read",
          signal: controller.signal,
          promptBuilder: ({ resultFile }) => buildIntakePrompt({
            task,
            thread: store.getThread(task.id),
            projects,
            resultFile,
          }),
        });
        if (!intakeRes.ok) {
          if (intakeRes.assignment && !intakeRes.assignment.ok) return { ran: true, ...handleUnroutable(task, intakeRes.assignment) };
          store.updateTask(task.id, { status: "failed", stage: "failed", errorText: intakeRes.runError });
          return { ran: true, status: "failed", error: intakeRes.runError };
        }
        noteAgent("intake", intakeRes.assignment);
        const out = intakeRes.ran.structured;
        if (!out) {
          store.updateTask(task.id, { status: "waiting", stage: "waiting_user", errorText: "Intake did not return a structured result." });
          return { ran: true, status: "waiting_user" };
        }
        if (out.title) store.updateTask(task.id, { title: out.title });

        if (out.status === "answer") {
          const delivery = {
            taskId: task.id,
            title: out.title || task.title,
            summary: out.answer,
            agentsUsed,
            filesChanged: [],
            auditVerdict: "n/a",
            auditRounds: 0,
            merged: false,
            awaitingShip: false,
          };
          runSpace.writeJson("delivery.json", delivery);
          store.addThreadMessage({ taskId: task.id, role: "intake", agent: intakeRes.assignment.provider, kind: "delivery", content: out.answer });
          store.updateTask(task.id, { status: "done", stage: "done", delivery });
          emit("done", { taskId: task.id, delivery });
          return { ran: true, status: "done", delivery };
        }

        if (out.status === "clarify") {
          const qText = out.question || (Array.isArray(out.questions) ? out.questions.join("\n") : "Could you clarify what you want built?");
          store.addThreadMessage({ taskId: task.id, role: "intake", agent: intakeRes.assignment.provider, kind: "question", content: qText });
          store.updateTask(task.id, { status: "waiting", stage: "waiting_user" });
          emit("needs_user", { taskId: task.id, question: qText });
          return { ran: true, status: "waiting_user", question: qText };
        }

        if (out.status === "approval_required") {
          const card = store.createApproval({
            taskId: task.id,
            kind: "approval",
            title: out.title || "Approval required",
            prompt: out.action || out.answer || task.originalText,
            choices: [{ label: "Approve", value: "yes" }, { label: "Cancel", value: "no" }],
            meta: { type: "hard_gate" },
          });
          store.updateTask(task.id, { status: "waiting", stage: "waiting_approval" });
          return { ran: true, status: "waiting_approval", approval: card };
        }

        if (out.status === "needs_auth" && out.service) {
          store.updateTask(task.id, { status: "waiting", stage: "waiting_auth", errorText: out.reason || `Connect ${out.service}` });
          if (authBroker) await authBroker.requestAuth({ taskId: task.id, service: out.service, reason: out.reason });
          return { ran: true, status: "waiting_auth" };
        }

        if (out.status !== "brief_ready") {
          store.updateTask(task.id, { status: "waiting", stage: "waiting_user", errorText: "Intake returned an unexpected state." });
          return { ran: true, status: "waiting_user" };
        }

        // Resolve or create the target project.
        let project = resolveProject(out.project || task.projectName || task.originalText, projects);
        if (!project && out.newProject) {
          project = await createManagedProject({ profile, profileDir, name: out.newProject, stakes: "sandbox" });
        }
        if (!project) {
          const names = projects.slice(0, 8).map(p => p.name).join(", ");
          const q = names
            ? `Which project is this for (${names})? Or give me a short name for a new project.`
            : "Give me a short name for this new project (or point me to an existing folder).";
          store.addThreadMessage({ taskId: task.id, role: "intake", kind: "question", content: q });
          store.updateTask(task.id, { status: "waiting", stage: "waiting_user" });
          return { ran: true, status: "waiting_user", question: q };
        }

        const stakes = stakesForProject(project, profile);
        const brief = {
          title: out.title || task.title,
          project: project.name,
          projectPath: project.path,
          stakes,
          complexity: out.complexity || "normal",
          summary: out.summary || task.originalText,
          requirements: out.requirements || [],
          nonGoals: out.nonGoals || [],
          acceptanceChecks: out.acceptanceChecks || [],
          verificationCommands: out.verificationCommands || [],
          referenceFiles: out.referenceFiles || [],
        };
        runSpace.writeJson("brief.json", brief);
        store.addThreadMessage({ taskId: task.id, role: "intake", agent: intakeRes.assignment.provider, kind: "brief", content: brief.summary, meta: brief });
        task = store.updateTask(task.id, {
          title: brief.title,
          projectName: project.name,
          projectPath: project.path,
          stakes,
          brief,
          stage: "planning",
        });
      } else if (task.brief && task.stage === "intake") {
        // Locked brief arrived directly from Muse / GrokBot!
        const project = resolveProject(task.brief.project || task.projectName || "", projects)
          || (task.brief.newProject ? await createManagedProject({ profile, profileDir, name: task.brief.newProject, stakes: "sandbox" }) : null);
        if (project) {
          const stakes = stakesForProject(project, profile);
          runSpace.writeJson("brief.json", { ...task.brief, project: project.name, projectPath: project.path, stakes });
          task = store.updateTask(task.id, { projectName: project.name, projectPath: project.path, stakes, stage: "planning" });
        } else {
          task = store.updateTask(task.id, { stage: "planning" });
        }
      }

      const brief = task.brief || runSpace.readJson("brief.json") || { summary: task.originalText, complexity: "normal", verificationCommands: [] };
      const stagedRefs = runSpace.stageReferenceFiles(brief.referenceFiles || []);

      // --- STAGE 2: PLANNING ---
      let planMarkdown = runSpace.readText("plan.md");
      if (task.stage === "planning") {
        const planRes = await executeStageWithFailover({
          task,
          stage: "planning",
          cwd: task.projectPath || profileDir,
          runSpace,
          mode: "read",
          complexity: brief.complexity || "normal",
          signal: controller.signal,
          promptBuilder: ({ resultFile }) => buildPlannerPrompt({
            task,
            brief,
            busHistory: runSpace.readBus(),
            resultFile,
          }),
        });
        if (!planRes.ok) {
          if (planRes.assignment && !planRes.assignment.ok) return { ran: true, ...handleUnroutable(task, planRes.assignment) };
          store.updateTask(task.id, { status: "failed", stage: "failed", errorText: planRes.runError });
          return { ran: true, status: "failed", error: planRes.runError };
        }
        if (planRes.skipped) {
          planMarkdown = `# Direct Execution Plan\n\n${brief.summary}\n`;
          runSpace.writeText("plan.md", planMarkdown);
        } else {
          noteAgent("plan", planRes.assignment);
          const pOut = planRes.ran.structured;
          if (!pOut || pOut.status !== "plan_ready") {
            store.updateTask(task.id, { status: "waiting", stage: "waiting_user", errorText: "Planner did not produce a verified plan." });
            return { ran: true, status: "waiting_user" };
          }
          planMarkdown = pOut.planMarkdown || `# Plan\n\n${brief.summary}`;
          runSpace.writeText("plan.md", planMarkdown);
          if (Array.isArray(pOut.verificationCommands) && pOut.verificationCommands.length) {
            brief.verificationCommands = pOut.verificationCommands;
            runSpace.writeJson("brief.json", brief);
          }
          postBus(runSpace, task.id, planRes.assignment.provider, "builder", "plan_ready", {
            model: planRes.assignment.modelId,
            effort: planRes.assignment.effort,
            verificationCommands: brief.verificationCommands,
          });
          store.addThreadMessage({ taskId: task.id, role: "planner", agent: planRes.assignment.provider, kind: "plan", content: planMarkdown });
        }
        task = store.updateTask(task.id, { stage: "building" });
      }

      // --- PREPARE ISOLATED WORKTREE ---
      recordStep(runSpace, task.id, { id: "worktree", stage: "worktree", title: "Preparing isolated worktree", status: "in_progress", detail: task.projectName || "workspace" });
      const wt = await prepareWorktree({
        repoPath: task.projectPath,
        taskId: task.id,
        worktreesDir,
      });
      recordStep(runSpace, task.id, { id: "worktree", stage: "worktree", title: "Preparing isolated worktree", status: "done", detail: wt.branch });
      task = store.updateTask(task.id, { branch: wt.branch, worktreePath: wt.worktreePath });

      // --- STAGE 3 & 4: BUILD <-> CLARIFY <-> CROSS-MODEL AUDIT <-> FIX LOOP ---
      let auditData = runSpace.readJson("audit.json");
      let clarifications = 0;

      while (true) {
        if (task.stage === "building" || task.stage === "fixing") {
          const isFix = task.stage === "fixing";
          const buildRes = await executeStageWithFailover({
            task,
            stage: task.stage,
            cwd: wt.worktreePath,
            runSpace,
            mode: "write",
            complexity: brief.complexity || "normal",
            preferredProvider: isFix ? task.builderAgent : task.assignedAgent,
            signal: controller.signal,
            promptBuilder: ({ resultFile }) => buildBuilderPrompt({
              task,
              brief,
              planMarkdown,
              busHistory: runSpace.readBus(),
              auditFindings: isFix ? auditData?.findings : null,
              stagedRefs,
              resultFile,
            }),
          });
          if (!buildRes.ok) {
            if (buildRes.assignment && !buildRes.assignment.ok) return { ran: true, ...handleUnroutable(task, buildRes.assignment) };
            store.updateTask(task.id, { status: "failed", stage: "failed", errorText: buildRes.runError });
            return { ran: true, status: "failed", error: buildRes.runError };
          }
          noteAgent(isFix ? "fix" : "build", buildRes.assignment);
          task = store.updateTask(task.id, { builderAgent: buildRes.assignment.provider });

          const bOut = buildRes.ran.structured;
          // Terminal agent-to-agent clarification: Builder asks Planner directly on the bus!
          if (bOut?.status === "clarify_plan" && bOut.question && clarifications < MAX_PLAN_CLARIFICATIONS) {
            clarifications++;
            postBus(runSpace, task.id, buildRes.assignment.provider, "planner", "clarify_plan", { question: bOut.question });
            const answerRes = await executeStageWithFailover({
              task,
              stage: "planning",
              cwd: wt.worktreePath,
              runSpace,
              mode: "read",
              signal: controller.signal,
              promptBuilder: ({ resultFile }) => buildPlannerPrompt({
                task,
                brief,
                busHistory: runSpace.readBus(),
                resultFile,
                clarificationQuestion: bOut.question,
              }),
            });
            if (answerRes.ok && answerRes.ran?.structured?.answer) {
              const ans = answerRes.ran.structured.answer;
              if (answerRes.ran.structured.planAddendum) {
                planMarkdown += `\n\n## Plan Addendum\n${answerRes.ran.structured.planAddendum}\n`;
                runSpace.writeText("plan.md", planMarkdown);
              }
              postBus(runSpace, task.id, answerRes.assignment.provider, buildRes.assignment.provider, "plan_answer", { answer: ans });
              continue; // Resume builder immediately with planner's answer!
            }
          }

          if (bOut?.status === "needs_auth" && bOut.service) {
            store.updateTask(task.id, { status: "waiting", stage: "waiting_auth", errorText: bOut.reason || `Connect ${bOut.service}` });
            if (authBroker) await authBroker.requestAuth({ taskId: task.id, service: bOut.service, reason: bOut.reason });
            return { ran: true, status: "waiting_auth" };
          }

          if (!bOut || bOut.status !== "completed") {
            const msg = bOut?.summary || "Builder stopped without confirming completion.";
            store.addThreadMessage({ taskId: task.id, role: "builder", agent: buildRes.assignment.provider, kind: "error", content: msg });
            store.updateTask(task.id, { status: "waiting", stage: "waiting_user", errorText: msg });
            return { ran: true, status: "waiting_user", error: msg };
          }

          // Deterministic ground-truth snapshot + optional test verification!
          const snap = await snapshotWorktree(wt.worktreePath, { baseCommit: wt.baseCommit });
          runSpace.writeText("diff.patch", snap.diff);
          let testLog = "";
          if (typeof runVerification === "function" && brief.verificationCommands?.length) {
            recordStep(runSpace, task.id, { id: "verifying", stage: "verifying", title: "Running verification checks", status: "in_progress", detail: brief.verificationCommands.join(" && ") });
            const vRes = await runVerification({ cwd: wt.worktreePath, commands: brief.verificationCommands });
            testLog = vRes.output || "";
            runSpace.writeText("test.log", testLog);
            recordStep(runSpace, task.id, { id: "verifying", stage: "verifying", title: "Running verification checks", status: vRes.ok === false ? "failed" : "done", detail: vRes.ok === false ? "Checks reported issues" : "All checks passed" });
          }

          postBus(runSpace, task.id, buildRes.assignment.provider, "auditor", isFix ? "fix_applied" : "build_complete", {
            summary: bOut.summary,
            changedFiles: snap.changedFiles,
            fingerprint: snap.fingerprint,
          });
          store.addThreadMessage({ taskId: task.id, role: "builder", agent: buildRes.assignment.provider, kind: "status", content: bOut.summary });
          task = store.updateTask(task.id, { stage: "auditing" });
        }

        if (task.stage === "auditing") {
          const snap = await snapshotWorktree(wt.worktreePath, { baseCommit: wt.baseCommit });
          const testLog = runSpace.readText("test.log");
          const auditRes = await executeStageWithFailover({
            task,
            stage: "auditing",
            cwd: wt.worktreePath,
            runSpace,
            mode: "read",
            builderProvider: task.builderAgent,
            signal: controller.signal,
            promptBuilder: ({ resultFile }) => buildAuditorPrompt({
              task,
              brief,
              planMarkdown,
              snapshot: snap,
              testLog,
              resultFile,
            }),
          });
          if (!auditRes.ok) {
            if (auditRes.assignment && !auditRes.assignment.ok) return { ran: true, ...handleUnroutable(task, auditRes.assignment) };
            store.updateTask(task.id, { status: "failed", stage: "failed", errorText: auditRes.runError });
            return { ran: true, status: "failed", error: auditRes.runError };
          }
          noteAgent("audit", auditRes.assignment);
          const aOut = auditRes.ran.structured;
          const nextRound = task.auditRound + 1;
          task = store.updateTask(task.id, { auditorAgent: auditRes.assignment.provider, auditRound: nextRound });

          if (aOut?.status === "clean") {
            auditData = { verdict: "clean", round: nextRound, auditor: auditRes.assignment.provider, model: auditRes.assignment.modelId, summary: aOut.summary, findings: [] };
            runSpace.writeJson("audit.json", auditData);
            postBus(runSpace, task.id, auditRes.assignment.provider, "system", "audit_clean", { summary: aOut.summary, round: nextRound });
            break; // Exit loop -> Deliver!
          }

          if (aOut?.status === "findings" && Array.isArray(aOut.findings) && aOut.findings.length > 0) {
            auditData = { verdict: "findings", round: nextRound, auditor: auditRes.assignment.provider, model: auditRes.assignment.modelId, summary: aOut.summary, findings: aOut.findings };
            runSpace.writeJson("audit.json", auditData);
            postBus(runSpace, task.id, auditRes.assignment.provider, task.builderAgent || "builder", "audit_findings", { round: nextRound, count: aOut.findings.length, findings: aOut.findings });

            if (nextRound >= MAX_AUDIT_ROUNDS) {
              const msg = `Audit round ${nextRound} still found ${aOut.findings.length} issue(s). Pausing for your review before another pass.`;
              store.addThreadMessage({ taskId: task.id, role: "auditor", agent: auditRes.assignment.provider, kind: "status", content: msg, meta: { findings: aOut.findings } });
              store.updateTask(task.id, { status: "waiting", stage: "waiting_user", errorText: msg });
              return { ran: true, status: "waiting_user", audit: auditData };
            }

            // Escalate model tier automatically when a fix round is needed on standard/sandbox!
            task = store.updateTask(task.id, {
              stage: "fixing",
              escalationLevel: task.escalationLevel + 1,
            });
            continue;
          }

          // Unreadable/missing verdict is NEVER treated as clean.
          const unreadable = "Auditor finished without a clear clean/findings verdict. Nothing was merged.";
          store.addThreadMessage({ taskId: task.id, role: "auditor", agent: auditRes.assignment.provider, kind: "error", content: unreadable });
          store.updateTask(task.id, { status: "waiting", stage: "waiting_user", errorText: unreadable });
          return { ran: true, status: "waiting_user", error: unreadable };
        }
      }

      // --- STAGE 5: COMMIT, MERGE POLICY & TOTAL OUTPUT DELIVERY CARD ---
      recordStep(runSpace, task.id, { id: "shipping", stage: "shipping", title: "Packaging Total Output", status: "in_progress", detail: "Committing verified changes" });
      const finalSnap = await snapshotWorktree(wt.worktreePath, { baseCommit: wt.baseCommit });
      const commit = await commitWorktree({
        worktreePath: wt.worktreePath,
        message: `feat(${task.projectName || "aios"}): ${task.title} (${task.id})`,
      });

      const targetProject = resolveProject(task.projectName || "", listAllProjects(profile));
      const mergePolicy = mergePolicyForProject(targetProject || { stakes: task.stakes }, profile);
      let merged = false;
      let awaitingShip = false;
      let mergeNote = null;

      if (mergePolicy === "auto" && commit.commitHash) {
        const mRes = await mergeBranchIntoRepo({ repoPath: task.projectPath, branch: wt.branch, baseBranch: wt.baseBranch });
        if (mRes.merged) {
          merged = true;
          await removeWorktree({ repoPath: task.projectPath, worktreePath: wt.worktreePath, branch: wt.branch, deleteBranch: true });
        } else {
          awaitingShip = true;
          mergeNote = mRes.detail || mRes.reason;
        }
      } else {
        awaitingShip = true;
      }

      const delivery = {
        taskId: task.id,
        title: task.title,
        project: task.projectName,
        stakes: task.stakes,
        branch: wt.branch,
        baseBranch: wt.baseBranch,
        commitHash: commit.commitHash || finalSnap.head,
        merged,
        awaitingShip,
        mergeNote,
        filesChanged: finalSnap.changedFiles,
        auditVerdict: auditData?.verdict || "clean",
        auditSummary: auditData?.summary || "",
        auditRounds: task.auditRound,
        builder: task.builderAgent,
        auditor: task.auditorAgent,
        agentsUsed,
        summary: `${brief.summary}\n\nVerified clean by ${task.auditorAgent} after ${task.auditRound} audit round${task.auditRound === 1 ? "" : "s"}. ${merged ? `Merged into ${wt.baseBranch}.` : `Committed on ${wt.branch} and ready for your 1-tap merge.`}`,
      };
      runSpace.writeJson("delivery.json", delivery);
      syncDeliveryToVault({ profile, task, delivery });
      recordStep(runSpace, task.id, {
        id: "shipping",
        stage: "shipping",
        title: merged ? `Merged into ${wt.baseBranch}` : "Ready for merge",
        status: "done",
        detail: `${finalSnap.changedFiles.length} file${finalSnap.changedFiles.length === 1 ? "" : "s"} changed`,
      });

      if (awaitingShip) {
        store.createApproval({
          taskId: task.id,
          kind: "ship",
          title: `Merge ${task.id} into ${wt.baseBranch}`,
          prompt: `${task.title} passed ${task.auditorAgent}'s audit (${finalSnap.changedFiles.length} file${finalSnap.changedFiles.length === 1 ? "" : "s"} changed on ${wt.branch}).${mergeNote ? `\nNote: ${mergeNote}` : ""}`,
          choices: [
            { label: `Merge into ${wt.baseBranch}`, value: "merge" },
            { label: "Keep branch only", value: "keep" },
          ],
          meta: { branch: wt.branch, baseBranch: wt.baseBranch, repoPath: task.projectPath, worktreePath: wt.worktreePath },
        });
        store.addThreadMessage({ taskId: task.id, role: "system", kind: "delivery", content: delivery.summary, meta: delivery });
        store.updateTask(task.id, { status: "waiting", stage: "ready_to_ship", delivery });
        emit("ready_to_ship", { taskId: task.id, delivery });
        return { ran: true, status: "ready_to_ship", delivery };
      }

      store.addThreadMessage({ taskId: task.id, role: "system", kind: "delivery", content: delivery.summary, meta: delivery });
      store.updateTask(task.id, { status: "done", stage: "done", delivery });
      emit("done", { taskId: task.id, delivery });
      return { ran: true, status: "done", delivery };
    } catch (err) {
      if (controller.signal.aborted) {
        store.updateTask(task.id, { status: "waiting", stage: "waiting_user", errorText: "Stopped at your request." });
        return { ran: true, status: "stopped" };
      }
      store.updateTask(task.id, { status: "failed", stage: "failed", errorText: err.message });
      store.addThreadMessage({ taskId: task.id, role: "system", kind: "error", content: err.message });
      return { ran: true, status: "failed", error: err.message };
    } finally {
      activeControllers.delete(task.id);
      releaseLock();
    }
  }

  function stopTask(taskId) {
    const ctrl = activeControllers.get(taskId);
    if (ctrl) ctrl.abort(Object.assign(new Error("Stopped"), { code: "STOPPED" }));
    store.updateTask(taskId, { stopRequestedAt: now() });
    return Boolean(ctrl);
  }

  function stopAll() {
    store.setQueuePaused(true);
    for (const ctrl of activeControllers.values()) {
      ctrl.abort(Object.assign(new Error("Paused"), { code: "PAUSED" }));
    }
  }

  /** Resumes a paused/waiting task with optional owner reply/note and optional explicit next provider. */
  function continueTask(taskId, { reply = null, nextAgent = null, source = "desktop" } = {}) {
    const task = store.getTask(taskId);
    if (!task) throw Object.assign(new Error(`Task "${taskId}" not found.`), { code: "TASK_MISSING" });
    if (reply && String(reply).trim()) {
      store.addThreadMessage({ taskId, role: "owner", kind: "message", content: String(reply).trim(), meta: { source } });
    }
    // Determine next stage cleanly (if failed/waiting during intake, return to intake; otherwise resume last active stage).
    const resumeStage = ["waiting_user", "waiting_auth", "waiting_approval", "waiting_quota", "failed"].includes(task.stage)
      ? (task.brief ? (task.worktreePath ? "building" : "planning") : "intake")
      : task.stage;

    // Single canonical assignedAgent field — fixes v1 P30 stale meta.requestedAgent bug!
    return store.updateTask(taskId, {
      status: "open",
      stage: resumeStage,
      assignedAgent: nextAgent || null,
      retryAfter: null,
      errorText: null,
    });
  }

  /** Completes a 1-tap ship/merge approval on critical/production repos. */
  async function executeShipApproval(approval, value) {
    const task = store.getTask(approval.taskId);
    if (!task) return { ok: false, error: "Task missing." };
    const { repoPath, worktreePath, branch, baseBranch } = approval.meta || {};
    if (value !== "merge") {
      const delivery = { ...(task.delivery || {}), awaitingShip: false, merged: false };
      store.updateTask(task.id, { status: "done", stage: "done", delivery });
      return { ok: true, merged: false, branch };
    }
    const merged = await mergeBranchIntoRepo({ repoPath, branch, baseBranch });
    if (!merged.merged) {
      store.addThreadMessage({ taskId: task.id, role: "system", kind: "error", content: `Merge held: ${merged.detail || merged.reason}` });
      return { ok: false, error: merged.detail || merged.reason };
    }
    await removeWorktree({ repoPath, worktreePath, branch, deleteBranch: true });
    const delivery = { ...(task.delivery || {}), awaitingShip: false, merged: true, commitHash: merged.commitHash };
    store.updateTask(task.id, { status: "done", stage: "done", delivery });
    store.addThreadMessage({ taskId: task.id, role: "system", kind: "status", content: `Merged ${branch} into ${baseBranch} (${merged.commitHash.slice(0, 8)}).` });
    emit("done", { taskId: task.id, delivery });
    return { ok: true, merged: true, commitHash: merged.commitHash };
  }

  /** Schedules ALL eligible open tasks across different projects concurrently! */
  async function tickQueue() {
    if (store.getQueueState().paused) return [];
    const current = now();
    const open = store.listTasks({ status: "open" }).filter(t => !(t.retryAfter && t.retryAfter > current));
    const launched = [];
    for (const task of open) {
      const lockKey = task.projectPath || task.projectName || `task:${task.id}`;
      if (locks.isLocked(lockKey)) continue;
      launched.push(processTask(task.id));
    }
    return Promise.all(launched);
  }

  return {
    locks,
    matchContinuationTarget: text => matchContinuationTarget(store, text),
    processTask,
    stopTask,
    stopAll,
    continueTask,
    executeShipApproval,
    tickQueue,
  };
}

module.exports = {
  MAX_AUDIT_ROUNDS,
  MAX_PLAN_CLARIFICATIONS,
  matchContinuationTarget,
  createPipeline,
};
