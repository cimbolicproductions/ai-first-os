(() => {
  "use strict";

  // Capture phone bearer token from URL fragment on first open, then scrub URL.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("t")) {
    try { localStorage.setItem("aios-token", hash.get("t")); } catch {}
    history.replaceState(null, "", location.pathname);
  }
  const authToken = (() => { try { return localStorage.getItem("aios-token") || ""; } catch { return ""; } })();

  const $ = id => document.getElementById(id);
  const state = { snapshot: null, focusId: null, detail: null, sending: false, progressUserToggle: new Map() };
  const approvalAppearedAt = new Map();
  const approvalViews = new WeakMap();
  const pendingSignIns = new Set();
  const expandedActivity = new Set();
  const agentLabels = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode" };
  const effortLabels = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
  let conversationKey = null;
  let deliveryKey = null;
  let activityThread = null;

  function agentIdentity(name, effort, model) {
    const key = String(name || "").toLowerCase().replace(/[\s-]/g, "");
    const provider = key === "claudecode" ? "claude" : key;
    if (!Object.hasOwn(agentLabels, provider)) return null;
    const variant = provider === "antigravity" ? /^gemini-[\d.]+-[a-z]+-(low|medium|high|xhigh|max)$/i.exec(model || "")?.[1] : null;
    const level = String(effort || variant || "").toLowerCase();
    return { provider, name: agentLabels[provider], effort: Object.hasOwn(effortLabels, level) ? level : "unknown" };
  }

  function setAgentIdentity(element, identity) {
    if (!identity) {
      delete element.dataset.provider;
      delete element.dataset.effort;
      return;
    }
    element.dataset.provider = identity.provider;
    element.dataset.effort = identity.effort;
  }

  function agentAttribution(element, identity, fallback = "") {
    const name = document.createElement("span");
    name.className = "msg-agent-name";
    name.textContent = identity?.name || fallback;
    element.replaceChildren(name);
    const effort = identity && effortLabels[identity.effort];
    if (effort) {
      const label = document.createElement("span");
      label.className = "msg-effort";
      label.textContent = effort;
      element.append(label);
    }
  }

  function modelLabel(provider, modelId) {
    if (provider !== "antigravity" || !modelId) return modelId;
    const gemini = /^gemini-([\d.]+)-([a-z]+)(?:-(low|medium|high|xhigh|max))?$/i.exec(modelId);
    if (!gemini) return modelId;
    const [, version, family, effort] = gemini;
    const name = `Gemini ${version} ${family[0].toUpperCase()}${family.slice(1)}`;
    return effort ? `${name} (${effort === "xhigh" ? "Extra High" : effort[0].toUpperCase() + effort.slice(1)})` : name;
  }
  const ARC_STEPS = [
    { id: "intake", stage: "intake", title: "Understanding request" },
    { id: "planning", stage: "planning", title: "Planning architecture" },
    { id: "building", stage: "building", title: "Building implementation" },
    { id: "auditing", stage: "auditing", title: "Cross-model review" },
    { id: "shipping", stage: "shipping", title: "Packaging Total Output" },
  ];
  let refreshDebounce = null;

  function apiHeaders(isJson = false) {
    return {
      ...(isJson ? { "content-type": "application/json" } : {}),
      ...(authToken ? { authorization: "Bearer " + authToken } : {}),
    };
  }

  async function apiGet(url) {
    const res = await fetch(url, { headers: apiHeaders(false) });
    const data = await res.json().catch(() => ({ ok: false, error: "Invalid server response" }));
    if (!res.ok || data.ok === false) throw new Error(data.error || "Request failed");
    return data;
  }

  async function apiPost(url, body = {}) {
    const res = await fetch(url, { method: "POST", headers: apiHeaders(true), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ ok: false, error: "Invalid server response" }));
    if (!res.ok || data.ok === false) throw new Error(data.error || "Request failed");
    return data;
  }

  function say(text) {
    $("statusMsg").textContent = text || "";
  }

  function safeHref(url) {
    try {
      const u = new URL(url, location.origin);
      return (u.protocol === "https:" || u.origin === location.origin) ? u.href : null;
    } catch {
      return null;
    }
  }

  function formatReset(ms) {
    if (!ms) return "cooldown";
    try {
      return "resets " + new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch {
      return "cooldown";
    }
  }

  function taskStatusLabel(task) {
    if (task.status === "failed") return "Needs attention";
    if (task.status === "running") return "Working";
    if (task.status === "open") return "Queued";
    if (task.status === "done") return "Complete";
    if (task.status === "cancelled") return "Cancelled";
    return ({ waiting_auth: "Needs sign-in", waiting_approval: "Needs approval", waiting_user: "Waiting for you",
      waiting_quota: "Waiting for agent availability", ready_to_ship: "Ready to merge" })[task.stage] || "Waiting";
  }

  function renderSidebar() {
    const list = $("threadList");
    const tasks = (state.snapshot?.tasks || []).filter(t => !t.putAway).slice().reverse();
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "muted tiny";
      empty.style.padding = "8px 12px";
      empty.textContent = "No threads yet.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...tasks.map(task => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thread-item" + (task.id === state.focusId ? " active" : "");
      const title = document.createElement("span");
      title.className = "thread-item-title";
      title.textContent = task.title;
      const sub = document.createElement("span");
      sub.className = "thread-item-sub";
      const dot = document.createElement("span");
      dot.className = "dot " + task.status;
      const meta = document.createElement("span");
      meta.textContent = `${task.id} · ${taskStatusLabel(task)}`;
      sub.append(dot, meta);
      btn.append(title, sub);
      btn.onclick = () => selectTask(task.id);
      return btn;
    }));
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const secs = Math.floor(ms / 1000);
    if (secs < 1) return "<1s";
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${mins}m ${String(rem).padStart(2, "0")}s`;
  }

  function buildDisplaySteps(task, recorded) {
    const isRunning = task.status === "running";
    const attemptStart = task.startedAt;
    const history = Array.isArray(recorded) ? recorded : [];
    const directBoardLookup = task.stage === "board_lookup" || history.some(step =>
      step.stage === "board_lookup" && attemptStart && step.startedAt >= attemptStart
    );
    const relevant = directBoardLookup ? history.filter(step => step.stage === "board_lookup") : history;
    const list = relevant.map(step => {
      if (step.status === "in_progress" && (!isRunning || (attemptStart && step.startedAt < attemptStart))) {
        return { ...step, status: task.status === "failed" ? "failed" : "waiting" };
      }
      // Older records could retain the previous attempt's start through a retry.
      if (attemptStart && step.startedAt < attemptStart && step.endedAt >= attemptStart) {
        return { ...step, startedAt: attemptStart };
      }
      return step;
    });

    // If a task just started before its first recorded step hits disk, synthesize the live step immediately.
    if (!list.length && isRunning) {
      const stage = task.stage || "intake";
      const match = ARC_STEPS.find(s => s.stage === stage);
      const activity = task.lastActivityAt >= attemptStart ? task.lastActivity : null;
      list.push({
        id: stage,
        stage,
        title: match?.title || (stage === "board_lookup" ? "Reading Agent Tasks" : "Working"),
        agent: task.assignedAgent || null,
        model: task.assignedModel || null,
        effort: task.assignedEffort || null,
        status: "in_progress",
        detail: activity || "Starting…",
        activities: activity ? [activity] : [],
        startedAt: attemptStart,
        endedAt: null,
      });
    }

    // A request can finish in intake. Show future stages only after a build has started.
    const activeStage = ["worktree", "fixing"].includes(task.stage) ? "building" : task.stage;
    const activeIdx = ARC_STEPS.findIndex(step => step.stage === activeStage);
    if (isRunning && activeIdx > 0) {
      const seenStages = new Set(list.map(step => step.stage));
      for (const arc of ARC_STEPS.slice(activeIdx + 1)) {
        if (!seenStages.has(arc.stage)) list.push({ ...arc, status: "pending" });
      }
    }
    return list;
  }

  function renderProgressCard(task, recordedSteps, issue = null) {
    const card = $("progressCard");
    const timerEl = $("progressTimer");
    timerEl.dataset.startedAt = "";
    if (!task) {
      card.hidden = true;
      return;
    }

    const steps = buildDisplaySteps(task, recordedSteps);
    const isRunning = task.status === "running";
    const isQueued = task.status === "open";
    const isDone = task.status === "done";
    const isWaiting = task.status === "waiting";
    const isFailed = task.status === "failed";
    const isCancelled = task.status === "cancelled";
    const isPassive = isDone || (isWaiting && !issue && !task.brief && task.stage === "waiting_user");

    card.hidden = !steps.length && !isRunning && !isQueued && !isWaiting && !isCancelled && !issue;
    card.className = "progress-card" + (isRunning ? " is-running" : isDone ? " is-done" : isWaiting ? " is-waiting" : isFailed ? " is-failed" : "");
    const anchor = $(isPassive ? "taskControls" : "approvalZone");
    if (anchor.previousElementSibling !== card) anchor.before(card);

    const collapsed = state.progressUserToggle.get(task.id) ?? true;
    card.classList.toggle("collapsed", collapsed);
    $("progressToggle").setAttribute("aria-expanded", String(!collapsed));

    // Leading icon
    const icon = $("progressIcon");
    if (isRunning) {
      const orb = document.createElement("span");
      orb.className = "orbit-loader";
      icon.replaceChildren(orb);
    } else {
      const badge = document.createElement("span");
      badge.className = "state-badge-icon " + (isDone ? "done" : isFailed ? "failed" : "waiting");
      badge.textContent = isDone ? "✓" : isFailed ? "!" : "•";
      icon.replaceChildren(badge);
    }

    const activeStep = steps.findLast(s => s.status === "in_progress") || null;
    const lastStep = steps.reduce((latest, step) => {
      const at = step.endedAt || step.startedAt || 0;
      return at && at >= (latest?.endedAt || latest?.startedAt || 0) ? step : latest;
    }, null);
    const headline = $("progressHeadline");
    if (isRunning) {
      const phase = activeStep?.stage || task.stage;
      headline.textContent = ({ intake: "Reading your message", planning: "Making a plan", building: "Working on changes",
        worktree: "Preparing the project", fixing: "Refining the changes", auditing: "Reviewing changes", verifying: "Running checks",
        shipping: "Preparing the result", board_lookup: "Checking Agent Tasks" })[phase] || "Working…";
    } else if (isQueued) {
      headline.textContent = "Queued";
    } else if (isFailed) {
      headline.textContent = "Couldn’t complete this request";
    } else if (task.stage === "ready_to_ship" && issue) {
      headline.textContent = "Merge needs attention";
    } else if (isPassive) {
      headline.textContent = "Run activity";
    } else {
      headline.textContent = taskStatusLabel(task);
    }
    const explanation = $("progressExplanation");
    explanation.hidden = !issue;
    explanation.textContent = issue || "";

    const agentEl = $("progressAgent");
    const identity = activeStep ? agentIdentity(activeStep.agent, activeStep.effort, activeStep.model) : null;
    setAgentIdentity(agentEl, identity);
    agentEl.hidden = !identity;
    agentAttribution(agentEl, identity);

    const firstStart = task.startedAt || steps.find(s => s.startedAt)?.startedAt;
    const lastEnd = isRunning ? Date.now()
      : (lastStep?.endedAt >= firstStart ? lastStep.endedAt : task.updatedAt);
    if (!isQueued && firstStart && lastEnd >= firstStart) {
      timerEl.hidden = false;
      timerEl.dataset.startedAt = isRunning ? String(firstStart) : "";
      timerEl.textContent = formatDuration(Math.max(0, lastEnd - firstStart));
    } else {
      timerEl.hidden = true;
    }

    const timeline = $("progressSteps");
    timeline.replaceChildren(...steps.map(step => {
      const li = document.createElement("li");
      li.className = "step-row " + (step.status || "pending");

      const marker = document.createElement("span");
      marker.className = "step-marker";
      if (step.status === "done") marker.textContent = "✓";
      else if (step.status === "failed") marker.textContent = "!";
      else if (step.status === "skipped") marker.textContent = "–";
      else if (step.status === "waiting") marker.textContent = "•";

      const content = document.createElement("div");
      content.className = "step-content";
      const titleRow = document.createElement("div");
      titleRow.className = "step-title-wrap";
      const title = document.createElement("span");
      title.className = "step-title";
      title.textContent = step.title;
      titleRow.append(title);
      content.append(titleRow);

      const stepIdentity = agentIdentity(step.agent, step.effort, step.model);
      if (stepIdentity) {
        const attribution = document.createElement("span");
        attribution.className = "activity-attribute";
        setAgentIdentity(attribution, stepIdentity);
        agentAttribution(attribution, stepIdentity);
        titleRow.append(attribution);
      }
      const metaParts = [stepIdentity ? modelLabel(stepIdentity.provider, step.model) : step.model, step.status !== "in_progress" ? step.detail : null].filter(Boolean);
      const uniqueMeta = [...new Set(metaParts)].join(" · ");
      if (uniqueMeta) {
        const meta = document.createElement("div");
        meta.className = "step-meta";
        meta.textContent = uniqueMeta;
        content.append(meta);
      }

      // Live streaming tool/file actions inside the active step (just like Antigravity / Claude Code / Codex)
      const feedLines = (step.activities || []).slice(-3);
      if (step.status === "in_progress" && (feedLines.length || step.detail)) {
        const lines = feedLines.length ? feedLines : [step.detail];
        const feed = document.createElement("div");
        feed.className = "step-feed";
        lines.forEach((line, idx) => {
          const item = document.createElement("div");
          item.className = "step-feed-line" + (idx === lines.length - 1 ? " latest" : "");
          item.textContent = line;
          feed.append(item);
        });
        content.append(feed);
      }

      const dur = document.createElement("span");
      dur.className = "step-dur";
      const endTs = step.endedAt || (step.status === "in_progress" ? Date.now() : null);
      if (step.startedAt && endTs >= step.startedAt) {
        dur.textContent = formatDuration(endTs - step.startedAt);
      }

      li.append(marker, content, dur);
      return li;
    }));
  }

  function renderAuthCodeForm(approval, zone) {
    const form = document.createElement("form");
    form.className = "auth-code-form";
    const label = document.createElement("label");
    label.textContent = "Claude authorization code";
    const input = document.createElement("input");
    input.type = "password";
    input.required = true;
    input.maxLength = 4096;
    input.autocomplete = "off";
    input.spellcheck = false;
    label.append(input);
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "btn primary small";
    button.textContent = "Complete Claude sign-in";
    const status = document.createElement("p");
    status.className = "muted tiny";
    status.setAttribute("role", "status");
    form.append(label, button, status);
    form.onsubmit = async event => {
      event.preventDefault();
      const code = input.value.trim();
      if (!code || button.disabled) return;
      input.value = "";
      input.disabled = button.disabled = true;
      const systemStatus = zone === $("systemAuthZone") ? $("systemAuthStatus") : null;
      if (systemStatus) systemStatus.textContent = "";
      status.textContent = "Verifying Claude sign-in…";
      try {
        await apiPost("/api/v2/auth/code", { approvalId: approval.id, code });
        const message = "Signed in to Claude Code.";
        status.textContent = message;
        if (systemStatus) systemStatus.textContent = message;
        else say(message);
        await refreshAll().catch(() => {});
      } catch (err) {
        status.textContent = err.message;
        input.disabled = button.disabled = false;
        await refreshAll().catch(() => {});
        if (input.isConnected) input.focus();
        else if (systemStatus) systemStatus.textContent = err.message;
        else say(err.message);
      }
    };
    return form;
  }

  function renderApprovals(approvals, zone = $("approvalZone")) {
    const view = JSON.stringify(approvals);
    // Keep the live form in place while phone polling returns the same cards.
    if (view === approvalViews.get(zone)) return;
    approvalViews.set(zone, view);
    const cards = approvals.map(a => {
      if (!approvalAppearedAt.has(a.id)) approvalAppearedAt.set(a.id, Date.now());
      const card = document.createElement("div");
      card.className = "card highlight";
      card.dataset.approvalId = a.id;
      const h = document.createElement("h3");
      h.textContent = a.title;
      const p = document.createElement("p");
      p.textContent = a.prompt;
      card.append(h, p);

      if (a.code) {
        const code = document.createElement("div");
        code.className = "device-code";
        code.textContent = a.code;
        card.append(code);
        if (a.service === "github" && a.expiresAt) {
          const expiry = document.createElement("p");
          expiry.className = "muted tiny";
          const expiresAt = new Date(a.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          expiry.textContent = `Expires at ${expiresAt}.`;
          card.append(expiry);
        }
      }

      const actions = document.createElement("div");
      actions.className = "card-actions";
      const href = a.link ? safeHref(a.link) : null;
      if (href) {
        const link = document.createElement("a");
        link.className = "btn primary";
        link.href = authToken && new URL(href).origin === location.origin ? `${href}#t=${encodeURIComponent(authToken)}` : href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = a.linkLabel || "Open sign-in link";
        actions.append(link);
      }
      if (a.kind === "auth" && a.service === "github") {
        const newCode = document.createElement("button");
        newCode.type = "button";
        newCode.className = "btn secondary";
        newCode.textContent = "Get a new code";
        newCode.onclick = async () => {
          newCode.disabled = true;
          await requestSystemAuth("github", "GitHub", a);
          newCode.disabled = false;
        };
        actions.append(newCode);
      }
      for (const [idx, choice] of (a.choices || []).entries()) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn " + (idx === 0 && !href ? "primary" : "secondary");
        btn.textContent = choice.label;
        btn.onclick = async () => {
          // 500ms accidental-click guard on freshly appeared approval cards.
          if (Date.now() - (approvalAppearedAt.get(a.id) || 0) < 500) return;
          btn.disabled = true;
          try {
            await apiPost(`/api/v2/approvals/${encodeURIComponent(a.id)}/answer`, { value: choice.value, digest: a.digest });
            say("Done.");
            await refreshAll();
          } catch (err) {
            btn.disabled = false;
            say(err.message);
          }
        };
        actions.append(btn);
      }
      card.append(actions);
      if (a.meta?.acceptsCode) card.append(renderAuthCodeForm(a, zone));
      return card;
    });
    zone.replaceChildren(...cards);
  }

  function renderDelivery(delivery, taskTitle) {
    const key = JSON.stringify([delivery, taskTitle]);
    if (deliveryKey === key) return;
    deliveryKey = key;
    const zone = $("deliveryZone");
    if (!delivery) {
      zone.replaceChildren();
      return;
    }
    const card = document.createElement("div");
    card.className = "card delivery";
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = delivery.merged ? "Result · Merged" : delivery.awaitingShip ? "Result · Ready to merge" : "Result";
    card.append(eyebrow);
    if (delivery.title && delivery.title !== taskTitle) {
      const title = document.createElement("h3");
      title.textContent = delivery.title;
      card.append(title);
    }
    const [preview, remaining] = splitAnswer(delivery.summary || "");
    const summary = document.createElement("p");
    summary.className = "msg-body";
    summary.textContent = preview;
    if (preview) card.append(summary);
    if (remaining) card.append(activityDisclosure("Read more", remaining, `${delivery.taskId}:result-summary`));

    const meta = [
      delivery.builder ? `Built by ${delivery.builder}` : null,
      delivery.auditor ? `Audited by ${delivery.auditor} (${delivery.auditVerdict || "clean"}, ${delivery.auditRounds || 0} round${delivery.auditRounds === 1 ? "" : "s"})` : null,
      delivery.branch ? `Branch ${delivery.branch}` : null,
      delivery.filesChanged?.length ? `${delivery.filesChanged.length} file${delivery.filesChanged.length === 1 ? "" : "s"} changed` : null,
    ].filter(Boolean).join("\n");
    if (meta) card.append(activityDisclosure("Build details", meta, `${delivery.taskId}:result`));
    zone.replaceChildren(card);
  }

  function activityDisclosure(label, text, key, identity = null) {
    const details = document.createElement("details");
    details.className = "activity-detail";
    setAgentIdentity(details, identity);
    details.open = expandedActivity.has(key);
    details.ontoggle = () => {
      if (details.isConnected) {
        if (details.open) expandedActivity.add(key);
        else expandedActivity.delete(key);
      }
    };
    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "activity-label";
    title.textContent = label;
    summary.append(title);
    if (identity) {
      const byline = document.createElement("span");
      byline.className = "activity-attribute";
      agentAttribution(byline, identity);
      summary.append(byline);
    }
    const body = document.createElement("div");
    body.className = "activity-body";
    body.textContent = text;
    details.append(summary, body);
    return details;
  }

  function splitAnswer(content) {
    const text = content.trim();
    if (text.length <= 480 && text.split("\n").length <= 6) return [text];
    const paragraphEnd = text.search(/\n\s*(?:\n|[•*-] |\d+[.)] )/);
    const preview = text.slice(0, 360);
    const sentenceEnd = [...preview.matchAll(/[.!?](?=\s|$)/g)].at(-1)?.index ?? -1;
    const splitAt = paragraphEnd > 0 && paragraphEnd <= 360 ? paragraphEnd
      : sentenceEnd >= 100 ? sentenceEnd + 1 : Math.max(1, preview.lastIndexOf(" "), preview.lastIndexOf("\n"), 1);
    return [text.slice(0, splitAt).trimEnd(), text.slice(splitAt).trimStart()];
  }

  function displayDelivery(detail) {
    const { task, thread = [], artifacts = {} } = detail;
    const result = task.delivery || artifacts.delivery || null;
    const earlierChat = !task.brief && result?.auditVerdict === "n/a" && thread.some(message =>
      message.role === "intake" && message.kind === "delivery" && message.content === result.summary);
    return earlierChat ? null : result;
  }

  function messageActivityLabel(message) {
    if (message.kind === "error") return "Earlier error";
    if (message.kind === "brief") return "Request brief";
    if (message.kind === "plan") return "Implementation plan";
    if (message.role === "builder") return "Work update";
    if (message.role === "auditor") return "Review update";
    if (/failing over|trying another eligible agent/i.test(message.content)) return "Agent handoff";
    if (/^connected to /i.test(message.content)) return "Sign-in update";
    if (/^merged /i.test(message.content)) return "Merge update";
    return "System update";
  }

  function currentIssue(detail) {
    const { task, thread = [] } = detail;
    if (task.status === "failed") return task.errorText || thread.findLast(message => message.kind === "error")?.content || "Try Continue to resume the task.";
    if (task.status !== "waiting") return null;
    const latest = thread.at(-1);
    return task.errorText || (task.stage === "ready_to_ship" && latest?.kind === "error" ? latest.content : null);
  }

  function renderTaskProgress(detail) {
    const issue = currentIssue(detail);
    renderProgressCard(detail.task, detail.steps || [], issue);
  }

  function renderConversation(detail, delivery) {
    const { task, thread = [], artifacts = {} } = detail;
    const issue = currentIssue(detail);
    const visible = thread.filter(message => {
      const duplicateResult = message.role === "system" && message.kind === "delivery" && message.meta && message.content === delivery?.summary;
      const duplicatePlan = message.kind === "plan" && message.content === artifacts.plan;
      const duplicateIssue = message.kind === "error" && message === thread.at(-1) && message.content === issue;
      return !duplicateResult && !duplicatePlan && !duplicateIssue;
    });
    const key = `${task.id}:${visible.map(message => message.id).join(",")}`;
    if (conversationKey === key) return;
    conversationKey = key;
    $("conversation").replaceChildren(...visible.map(message => {
      const owner = message.role === "owner" || message.role === "user";
      const reply = message.role === "assistant" || message.kind === "question" || message.kind === "delivery";
      const identity = agentIdentity(message.agent, message.meta?.effort, message.meta?.modelId);
      const messageKey = `${task.id}:${message.id}`;
      if (!owner && !reply) return activityDisclosure(messageActivityLabel(message), message.content, messageKey, identity);

      const box = document.createElement("div");
      box.className = "msg " + (owner ? "owner" : "agent");
      if (!owner) setAgentIdentity(box, identity);
      const head = document.createElement("span");
      head.className = "msg-head";
      if (owner) head.textContent = "You";
      else agentAttribution(head, identity, message.meta?.boardIntent || /^Agent Tasks has /i.test(message.content) ? "Agent Tasks" : "AI-first OS");
      const [preview, remaining] = owner || message.kind === "question" ? [message.content] : splitAnswer(message.content);
      const body = document.createElement("div");
      body.className = "msg-body";
      body.textContent = preview;
      box.append(head, body);
      if (remaining) box.append(activityDisclosure("Read more", remaining, messageKey));
      return box;
    }));
  }

  function renderFocus() {
    const detail = state.detail;
    const task = detail?.task || null;
    $("emptyState").hidden = Boolean(task);
    $("focusView").hidden = !task;

    if (!task) {
      renderProgressCard(null);
      $("composerInput").placeholder = "Ask a question or share an idea…";
      $("sendBtn").textContent = "Send";
      return;
    }

    $("taskIdBadge").textContent = task.id;
    $("taskProjectBadge").hidden = !task.projectName;
    $("taskProjectBadge").textContent = task.projectName || "";
    $("taskStakesBadge").hidden = !task.stakes;
    $("taskStakesBadge").className = "pill " + task.stakes;
    $("taskStakesBadge").textContent = task.stakes;
    $("taskTitle").textContent = task.title;
    renderTaskProgress(detail);

    renderApprovals(detail.approvals || []);
    const delivery = displayDelivery(detail);
    renderDelivery(delivery, task.title);
    renderConversation(detail, delivery);

    if (activityThread !== task.id) {
      $("busDrawer").open = false;
      $("diffDrawer").open = false;
      activityThread = task.id;
    }

    // Terminal Agent Bus drawer
    const bus = detail.bus || [];
    $("busDrawer").hidden = bus.length === 0;
    $("busCount").textContent = String(bus.length);
    $("busList").replaceChildren(...bus.map(b => {
      const row = document.createElement("div");
      row.className = "bus-entry";
      row.textContent = `${b.fromAgent} -> ${b.toAgent} [${b.msgType}]: ${JSON.stringify(b.payload)}`;
      return row;
    }));

    // Plan & Diff drawer
    const plan = detail.artifacts?.plan;
    const diff = detail.artifacts?.diff;
    $("diffDrawer").hidden = !plan && !diff;
    $("planPre").hidden = !plan;
    $("planPre").textContent = plan || "";
    $("diffPre").hidden = !diff;
    $("diffPre").textContent = diff || "";

    // Action controls
    const running = task.status === "running";
    const stopped = task.status === "waiting" || task.status === "failed";
    $("taskControls").hidden = !running && !stopped && task.status !== "done";
    $("stopOneBtn").hidden = !running;
    $("continueBtn").hidden = !stopped || task.stage === "waiting_approval" || task.stage === "ready_to_ship";
    $("putAwayBtn").hidden = running;

    $("composerInput").placeholder = task.stage === "waiting_user"
      ? "Reply here…"
      : "Ask a follow-up or describe a change…";
    $("sendBtn").textContent = task.stage === "waiting_user" ? "Reply" : "Send";
  }

  async function requestSystemAuth(service, label, approval = null) {
    if (pendingSignIns.has(service)) return;
    const inSystem = $("healthModal").open;
    const report = inSystem ? text => { $("systemAuthStatus").textContent = text; } : say;
    pendingSignIns.add(service);
    report(approval ? `Requesting a new ${label} code…` : `Preparing ${label} sign-in…`);
    renderHealthModal();
    try {
      const { card } = await apiPost("/api/v2/auth/request", {
        service,
        reason: `Sign in to ${label}`,
        ...(approval ? { taskId: approval.taskId, replaceApprovalId: approval.id } : {}),
      });
      await refreshAll();
      report(card?.alreadyConnected ? `${label} is connected.` : "");
      if (inSystem && !$("healthModal").open) return;
      const zone = inSystem ? $("systemAuthZone") : $("approvalZone");
      const visibleCard = [...zone.children].find(el => el.dataset.approvalId === card?.id);
      visibleCard?.scrollIntoView({ block: "nearest" });
      if (!card?.alreadyConnected && !visibleCard) {
        report(`No ${label} sign-in link is available. Try again.`);
      }
    } catch (err) {
      report(err.message);
    } finally {
      pendingSignIns.delete(service);
      if ($("healthModal").open) renderHealthModal();
    }
  }

  function renderHealthModal() {
    const snap = state.snapshot;
    if (!snap) return;
    const authCards = (snap.approvals || []).filter(a => a.kind === "auth");
    renderApprovals(authCards, $("systemAuthZone"));

    $("harnessList").replaceChildren(...(snap.harnesses || []).map(h => {
      const row = document.createElement("div");
      row.className = "kv-row";
      const left = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = h.label;
      const sub = document.createElement("div");
      sub.className = "muted tiny";
      sub.textContent = h.quotaStatus === "exhausted"
        ? `Usage limit (${formatReset(h.resetAt)})`
        : h.quotaStatus === "auth_expired" ? "Sign-in expired"
        : h.state === "signed-in" ? (h.free ? "Ready · Free" : "Signed in")
        : h.state === "installed" ? "Installed · Needs sign-in" : h.state;
      left.append(strong, sub);
      row.append(left);
      if (h.installed && (!h.signedIn || h.quotaStatus === "auth_expired") && !authCards.some(a => a.service === h.id && a.link)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn secondary small";
        btn.textContent = pendingSignIns.has(h.id) ? "Preparing…" : "Sign-in link";
        btn.disabled = pendingSignIns.has(h.id);
        btn.onclick = () => requestSystemAuth(h.id, h.label);
        row.append(btn);
      }
      return row;
    }));

    const modelSettings = snap.modelSettings || {};
    const overrides = modelSettings.overrides || {};
    const disabledProviders = new Set(modelSettings.disabledProviders || []);
    const effortsMap = modelSettings.providerEfforts || {};

    $("modelList").replaceChildren(...(snap.harnesses || []).map(h => {
      const provider = h.id;
      const fromSubscription = provider === "antigravity";
      const choices = (snap.models || []).filter(m => m.provider === provider && (!fromSubscription || m.status === "listed"));
      const pin = overrides[provider];
      const isDisabled = disabledProviders.has(provider) || overrides[provider] === "__disabled__";
      const automaticModel = modelSettings.automaticModels?.[provider];
      const activeModel = isDisabled
        ? "__disabled__"
        : fromSubscription ? (choices.some(m => m.modelId === pin) ? pin : "__automatic__")
        : (pin
          || choices.find(m => m.tier === "workhorse" && m.isDefault)?.modelId
          || choices.find(m => m.isDefault)?.modelId
          || choices[0]?.modelId
          || "__disabled__");

      const row = document.createElement("div");
      row.className = "kv-row";

      const left = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = h.label;
      const sub = document.createElement("div");
      sub.className = "muted tiny";
      const efforts = effortsMap[provider] || [];
      sub.textContent = isDisabled
        ? "Disabled — excluded from routing"
        : fromSubscription
          ? (modelSettings.antigravityCatalog?.status === "updated"
            ? `${choices.length} model options from your signed-in account`
            : choices.length ? "Showing the last model list from your account" : "Check new models to load your account’s list")
          : (efforts.length ? `Effort scales: ${efforts.join(" · ")}` : "Active");
      left.append(strong, sub);

      const controls = document.createElement("div");
      controls.className = "model-controls";

      const sel = document.createElement("select");
      sel.setAttribute("aria-label", `${h.label} model`);
      if (fromSubscription) {
        sel.append(new Option(automaticModel ? `Automatic · ${modelLabel(provider, automaticModel)}` : "Automatic", "__automatic__"));
      }
      const seenIds = new Set();
      for (const m of choices) {
        seenIds.add(m.modelId);
        const label = m.tier === "apex" ? `${m.modelId} (apex)` : modelLabel(provider, m.modelId);
        sel.append(new Option(label, m.modelId));
      }
      if (!fromSubscription && !isDisabled && activeModel && activeModel !== "__disabled__" && !seenIds.has(activeModel)) {
        sel.append(new Option(activeModel, activeModel));
      }
      sel.append(new Option("Disabled (don't use)", "__disabled__"));
      if (!fromSubscription) sel.append(new Option("Add custom model…", "__custom__"));
      sel.value = activeModel;

      sel.onchange = async () => {
        let nextModel = sel.value;
        if (nextModel === "__custom__") {
          const typed = window.prompt(`Enter model ID for ${h.label}:`);
          if (!typed || !typed.trim()) {
            sel.value = activeModel;
            return;
          }
          nextModel = typed.trim();
        }
        try {
          await apiPost("/api/v2/models/select", { provider, modelId: nextModel });
          $("modelRefreshStatus").textContent = nextModel === "__disabled__" ? `${h.label} disabled.`
            : nextModel === "__automatic__" ? "Antigravity now follows your account’s model list."
              : `${h.label} set to ${modelLabel(provider, nextModel)}.`;
          await refreshAll();
        } catch (err) {
          sel.value = activeModel;
          $("modelRefreshStatus").textContent = err.message;
        }
      };

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn danger-ghost small";
      removeBtn.textContent = "Remove";
      removeBtn.title = "Remove selected model from choices";
      removeBtn.disabled = isDisabled || !activeModel || activeModel === "__automatic__";
      removeBtn.onclick = async () => {
        if (removeBtn.disabled) return;
        try {
          await apiPost("/api/v2/models/remove", { provider, modelId: activeModel });
          $("modelRefreshStatus").textContent = `Removed ${modelLabel(provider, activeModel)} from ${h.label}.`;
          await refreshAll();
        } catch (err) {
          $("modelRefreshStatus").textContent = err.message;
        }
      };

      controls.append(sel, removeBtn);
      row.append(left, controls);
      return row;
    }));

    $("serviceList").replaceChildren(...(snap.services || []).filter(s => s.kind !== "cli-oauth").map(s => {
      const row = document.createElement("div");
      row.className = "kv-row";
      const left = document.createElement("span");
      const connection = s.connected ? "Connected"
        : s.id === "github" && s.connected === null ? "Connection not checked" : "Not connected";
      left.textContent = `${s.label} · ${connection}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn secondary small";
      if (s.id === "github") {
        btn.textContent = s.connected ? "Check connection" : "Connect";
        btn.disabled = pendingSignIns.has(s.id);
        btn.onclick = () => requestSystemAuth(s.id, s.label);
      } else {
        btn.textContent = s.connected ? "Reconnect" : "Connect";
        btn.onclick = async () => {
          await apiPost("/api/v2/auth/request", { service: s.id, reason: `Connect ${s.label}` });
          $("healthModal").close();
          await refreshAll();
        };
      }
      row.append(left, btn);
      return row;
    }));

    $("projectList").replaceChildren(...(snap.projects || []).slice(0, 30).map(p => {
      const row = document.createElement("div");
      row.className = "kv-row";
      const name = document.createElement("span");
      name.textContent = p.name;
      const sel = document.createElement("select");
      for (const s of ["critical", "standard", "sandbox"]) sel.append(new Option(s, s));
      sel.value = p.stakes || "standard";
      sel.onchange = async () => {
        await apiPost("/api/v2/profile/project-stakes", { name: p.name, stakes: sel.value });
        say(`Updated ${p.name} stakes to ${sel.value}.`);
        await refreshAll();
      };
      row.append(name, sel);
      return row;
    }));

    const connZone = $("connectorZone");
    const phoneBtn = document.createElement("button");
    phoneBtn.type = "button";
    phoneBtn.className = "btn secondary small";
    phoneBtn.textContent = "Show Phone QR";
    phoneBtn.onclick = async () => {
      const pair = await apiGet("/api/v2/phone/pairing");
      $("phoneQrWrap").hidden = false;
      $("phoneQrImg").src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(pair.qr);
      $("phoneUrlInput").value = pair.url;
    };
    const museBtn = document.createElement("button");
    museBtn.type = "button";
    museBtn.className = "btn secondary small";
    museBtn.textContent = snap.museEnabled ? "Rotate Muse key" : "Enable Muse connector";
    museBtn.onclick = async () => {
      const res = await apiPost("/api/v2/connectors/token", { connector: "muse" });
      say(`Muse OpenAPI: ${res.openApiUrl} · Key: ${res.token}`);
      await refreshAll();
    };
    const grokStatus = document.createElement("span");
    grokStatus.className = "muted tiny";
    grokStatus.textContent = snap.grokbot?.installed
      ? `GrokBot detected (${snap.grokbot.daemonConfigured ? "daemon ready" : "installed"})`
      : "GrokBot not detected";

    const row = document.createElement("div");
    row.className = "kv-row";
    row.append(grokStatus, phoneBtn, museBtn);
    connZone.replaceChildren(row);
  }

  async function selectTask(taskId) {
    state.focusId = taskId;
    closeMobileSidebar();
    await apiPost("/api/v2/focus", { taskId }).catch(() => {});
    if (state.focusId !== taskId) return;
    const detail = taskId ? await apiGet(`/api/v2/tasks/${encodeURIComponent(taskId)}`).catch(err => {
      if (state.focusId === taskId) say(err.message);
      return null;
    }) : null;
    if (state.focusId !== taskId) return;
    state.detail = detail;
    renderSidebar();
    renderFocus();
  }

  async function refreshAll() {
    const requestedFocusId = state.focusId;
    state.snapshot = await apiGet("/api/v2/state");
    const paused = state.snapshot.queuePaused === true;
    $("pauseBanner").hidden = !paused;
    $("pauseBtn").textContent = paused ? "Resume" : "Stop all";

    if (state.focusId === requestedFocusId &&
        (state.focusId === undefined || (state.focusId && !state.snapshot.tasks.some(t => t.id === state.focusId && !t.putAway)))) {
      state.focusId = state.snapshot.focusTaskId || null;
    }
    const focusId = state.focusId;
    const detail = focusId
      ? await apiGet(`/api/v2/tasks/${encodeURIComponent(focusId)}`).catch(() => null)
      : null;
    renderSidebar();
    if (state.focusId === focusId) {
      state.detail = detail;
      renderFocus();
    }
    if ($("healthModal").open) renderHealthModal();
  }

  const mobileMq = window.matchMedia("(max-width: 820px)");

  function closeMobileSidebar() {
    $("sidebar").classList.remove("open");
    $("sidebarBackdrop").hidden = true;
  }

  function applyDesktopSidebarState() {
    let collapsed = false;
    try { collapsed = localStorage.getItem("aios-sidebar-collapsed") === "1"; } catch {}
    $("shell").classList.toggle("sidebar-collapsed", !mobileMq.matches && collapsed);
    $("drawerToggle").setAttribute("aria-expanded", String(mobileMq.matches ? $("sidebar").classList.contains("open") : !collapsed));
  }

  function toggleSidebar() {
    if (mobileMq.matches) {
      const opening = !$("sidebar").classList.contains("open");
      $("sidebar").classList.toggle("open", opening);
      $("sidebarBackdrop").hidden = !opening;
      $("drawerToggle").setAttribute("aria-expanded", String(opening));
    } else {
      const collapsed = $("shell").classList.toggle("sidebar-collapsed");
      try { localStorage.setItem("aios-sidebar-collapsed", collapsed ? "1" : "0"); } catch {}
      $("drawerToggle").setAttribute("aria-expanded", String(!collapsed));
    }
  }

  applyDesktopSidebarState();
  mobileMq.addEventListener?.("change", () => {
    closeMobileSidebar();
    applyDesktopSidebarState();
  });

  $("drawerToggle").onclick = toggleSidebar;
  $("sidebarClose").onclick = closeMobileSidebar;
  $("sidebarBackdrop").onclick = closeMobileSidebar;
  $("newBtn").onclick = () => { selectTask(null); $("composerInput").focus(); };
  $("healthBtn").onclick = () => { renderHealthModal(); $("healthModal").showModal(); };
  $("closeHealth").onclick = () => $("healthModal").close();
  $("progressToggle").onclick = () => {
    if (!state.focusId) return;
    const next = !$("progressCard").classList.contains("collapsed");
    state.progressUserToggle.set(state.focusId, next);
    $("progressCard").classList.toggle("collapsed", next);
    $("progressToggle").setAttribute("aria-expanded", String(!next));
  };

  $("pauseBtn").onclick = async () => {
    const nextPaused = !(state.snapshot?.queuePaused === true);
    await apiPost("/api/v2/queue", { paused: nextPaused });
    await refreshAll();
  };
  $("resumeBtn").onclick = async () => {
    await apiPost("/api/v2/queue", { paused: false });
    await refreshAll();
  };

  $("stopOneBtn").onclick = async () => {
    if (!state.focusId) return;
    await apiPost(`/api/v2/tasks/${encodeURIComponent(state.focusId)}/stop`);
    say("Stopping this task.");
    await refreshAll();
  };
  $("continueBtn").onclick = async () => {
    if (!state.focusId) return;
    await apiPost(`/api/v2/tasks/${encodeURIComponent(state.focusId)}/continue`);
    say("Resuming with next eligible agent.");
    await refreshAll();
  };
  $("putAwayBtn").onclick = async () => {
    if (!state.focusId) return;
    await apiPost(`/api/v2/tasks/${encodeURIComponent(state.focusId)}/put-away`, { putAway: true });
    state.focusId = null;
    await refreshAll();
  };
  $("refreshModelsBtn").onclick = async () => {
    const button = $("refreshModelsBtn");
    const status = $("modelRefreshStatus");
    button.disabled = true;
    button.textContent = "Checking…";
    status.textContent = "Checking the signed-in model catalogs…";
    try {
      const report = await apiPost("/api/v2/models/refresh");
      const antigravity = report.providerResults?.find(result => result.provider === "antigravity");
      status.textContent = antigravity?.status === "updated"
        ? `Antigravity checked. ${antigravity.count} model options available in AI-first OS.`
        : "Couldn’t read Antigravity’s account list. Try again or check its sign-in on the computer.";
      await refreshAll();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = "Check new models";
    }
  };

  $("composer").onsubmit = async e => {
    e.preventDefault();
    const input = $("composerInput");
    const draft = input.value;
    const text = draft.trim();
    if (!text || state.sending) return;
    const targetId = state.focusId;
    if (targetId && state.detail?.task?.id !== targetId) {
      say("Opening the thread. Try again in a moment.");
      return;
    }
    state.sending = true;
    $("sendBtn").disabled = true;
    try {
      const endpoint = targetId ? `/api/v2/tasks/${encodeURIComponent(targetId)}/reply` : "/api/v2/tasks";
      const res = await apiPost(endpoint, { text });
      if (state.focusId === targetId && res.task?.id) state.focusId = res.task.id;
      if (input.value === draft) input.value = "";
      say("");
      await refreshAll();
    } catch (err) {
      say(err.message);
    } finally {
      state.sending = false;
      $("sendBtn").disabled = false;
    }
  };

  $("composerInput").onkeydown = e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  };

  $("voiceBtn").onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { say("Use your device keyboard mic, then press Send."); return; }
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    say("Listening…");
    rec.onresult = e => {
      const said = Array.from(e.results, r => r[0].transcript).join(" ").trim();
      $("composerInput").value = ($("composerInput").value ? $("composerInput").value + " " : "") + said;
      say("");
    };
    rec.onerror = () => say("Did not catch that.");
    rec.start();
  };

  // Live SSE updates (instant in-place step/activity patches + lightweight fallback poll).
  function scheduleRefresh(delayMs = 250) {
    if (refreshDebounce) clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => {
      refreshDebounce = null;
      refreshAll().catch(() => {});
    }, delayMs);
  }

  function connectEvents() {
    if (authToken || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/v2/events");
    es.onmessage = e => {
      let evt = null;
      try { evt = JSON.parse(e.data); } catch {}
      if (evt && state.detail?.task && evt.taskId === state.focusId && (evt.type === "activity" || evt.type === "step_updated")) {
        if (Array.isArray(evt.steps)) state.detail.steps = evt.steps;
        if (evt.text) state.detail.task.lastActivity = evt.text;
        renderTaskProgress(state.detail);
        return;
      }
      scheduleRefresh(180);
    };
    es.onerror = () => { es.close(); setTimeout(connectEvents, 5000); };
  }

  // Smooth 1s elapsed timer tick while a task is actively running (zero full re-renders).
  setInterval(() => {
    const timerEl = $("progressTimer");
    if (!timerEl || !timerEl.dataset.startedAt) return;
    const started = Number(timerEl.dataset.startedAt);
    if (started) timerEl.textContent = formatDuration(Math.max(0, Date.now() - started));
  }, 1000);

  refreshAll().then(connectEvents).catch(err => say(err.message));
  setInterval(() => { refreshAll().catch(() => {}); }, 10000);
})();
