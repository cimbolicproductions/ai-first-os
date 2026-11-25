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
      meta.textContent = [task.id, task.projectName || task.stage].filter(Boolean).join(" · ");
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
    const list = Array.isArray(recorded) ? recorded.map(s => ({ ...s })) : [];
    const seenStages = new Set(list.map(s => s.stage));
    const isRunning = task.status === "running" || task.status === "open";
    const isDone = task.status === "done";

    // If a task just started before its first recorded step hits disk, synthesize the live step immediately.
    if (!list.length && isRunning) {
      const stage = task.stage || "intake";
      const match = ARC_STEPS.find(s => s.stage === stage) || ARC_STEPS[0];
      list.push({
        id: match.id,
        stage: match.stage,
        title: match.title,
        agent: task.assignedAgent || null,
        model: task.assignedModel || null,
        status: "in_progress",
        detail: task.lastActivity || "Starting…",
        activities: task.lastActivity ? [task.lastActivity] : [],
        startedAt: task.startedAt || task.createdAt || Date.now(),
        endedAt: null,
      });
      seenStages.add(match.stage);
    }

    // Append quiet upcoming ghost steps while work is active so the full arc is visible at a glance.
    if (!isDone && task.status !== "failed") {
      const activeIdx = ARC_STEPS.findIndex(s => s.stage === (task.stage === "fixing" ? "building" : task.stage));
      for (let i = 0; i < ARC_STEPS.length; i++) {
        const arc = ARC_STEPS[i];
        if (seenStages.has(arc.stage)) continue;
        if (activeIdx >= 0 && i < activeIdx) continue;
        list.push({ ...arc, status: "pending", detail: null, activities: [] });
      }
    }
    return list;
  }

  function renderProgressCard(task, recordedSteps) {
    const card = $("progressCard");
    if (!task) {
      card.hidden = true;
      return;
    }

    const steps = buildDisplaySteps(task, recordedSteps);
    const isRunning = task.status === "running" || task.status === "open";
    const isDone = task.status === "done";
    const isWaiting = task.status === "waiting";
    const isFailed = task.status === "failed";

    card.hidden = !steps.length && !isRunning && !task.errorText;
    card.className = "progress-card" + (isRunning ? " is-running" : isDone ? " is-done" : isWaiting ? " is-waiting" : isFailed ? " is-failed" : "");

    const defaultCollapsed = isDone || (isWaiting && task.stage !== "waiting_quota");
    const userPref = state.progressUserToggle.get(task.id);
    const collapsed = userPref !== undefined ? userPref : defaultCollapsed;
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

    const activeStep = steps.find(s => s.status === "in_progress") || null;
    const completedCount = steps.filter(s => s.status === "done").length;

    const headline = $("progressHeadline");
    headline.className = "progress-headline" + (isRunning ? " shimmer" : "");
    if (isRunning) {
      headline.textContent = activeStep?.detail || task.lastActivity || activeStep?.title || "Working…";
    } else if (isDone) {
      headline.textContent = `Completed · ${completedCount} step${completedCount === 1 ? "" : "s"}`;
    } else if (isFailed) {
      headline.textContent = task.errorText || "Stopped with an error";
    } else if (task.stage === "ready_to_ship") {
      headline.textContent = `Verified & ready to merge · ${completedCount} step${completedCount === 1 ? "" : "s"}`;
    } else {
      headline.textContent = task.errorText || "Waiting for your input";
    }

    const sub = $("progressSub");
    if (isRunning && activeStep && activeStep.detail && activeStep.detail !== activeStep.title) {
      sub.hidden = false;
      sub.textContent = activeStep.title;
    } else {
      sub.hidden = true;
    }

    const agentEl = $("progressAgent");
    const agentText = activeStep?.agent
      ? [activeStep.agent, activeStep.model].filter(Boolean).join(" · ")
      : (isRunning && task.assignedAgent ? [task.assignedAgent, task.assignedModel].filter(Boolean).join(" · ") : "");
    agentEl.hidden = !agentText;
    agentEl.textContent = agentText;

    const timerEl = $("progressTimer");
    const firstStart = steps.find(s => s.startedAt)?.startedAt || task.startedAt || task.createdAt || null;
    const lastEnd = isRunning ? Date.now() : (steps.reduce((mx, s) => Math.max(mx, s.endedAt || 0), 0) || task.updatedAt || Date.now());
    if (firstStart) {
      timerEl.hidden = false;
      timerEl.dataset.startedAt = isRunning ? String(firstStart) : "";
      timerEl.textContent = formatDuration(Math.max(0, lastEnd - firstStart));
    } else {
      timerEl.hidden = true;
      timerEl.dataset.startedAt = "";
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

      const content = document.createElement("div");
      content.className = "step-content";
      const title = document.createElement("div");
      title.className = "step-title";
      title.textContent = step.title;
      content.append(title);

      const metaParts = [step.agent, step.model, step.status === "done" || step.status === "skipped" || step.status === "failed" ? step.detail : null].filter(Boolean);
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
      if (step.startedAt) {
        const endTs = step.endedAt || (step.status === "in_progress" ? Date.now() : step.startedAt);
        dur.textContent = formatDuration(Math.max(0, endTs - step.startedAt));
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

  function renderDelivery(delivery) {
    const zone = $("deliveryZone");
    if (!delivery) {
      zone.replaceChildren();
      return;
    }
    const card = document.createElement("div");
    card.className = "card delivery";
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = delivery.merged ? "Total Output · Merged" : delivery.awaitingShip ? "Total Output · Verified & Ready" : "Total Output";
    const title = document.createElement("h3");
    title.textContent = delivery.title || "Finished";
    const summary = document.createElement("p");
    summary.className = "msg-body";
    summary.textContent = delivery.summary || "";
    card.append(eyebrow, title, summary);

    const meta = document.createElement("p");
    meta.className = "muted tiny";
    meta.textContent = [
      delivery.builder ? `Built by ${delivery.builder}` : null,
      delivery.auditor ? `Audited by ${delivery.auditor} (${delivery.auditVerdict || "clean"}, ${delivery.auditRounds || 0} round${delivery.auditRounds === 1 ? "" : "s"})` : null,
      delivery.branch ? `Branch ${delivery.branch}` : null,
      delivery.filesChanged?.length ? `${delivery.filesChanged.length} file${delivery.filesChanged.length === 1 ? "" : "s"} changed` : null,
    ].filter(Boolean).join(" · ");
    if (meta.textContent) card.append(meta);
    zone.replaceChildren(card);
  }

  function renderFocus() {
    const detail = state.detail;
    const task = detail?.task || null;
    $("emptyState").hidden = Boolean(task);
    $("focusView").hidden = !task;

    if (!task) {
      $("composerInput").placeholder = "Tell AI-first OS what to build, check, or answer…";
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
    renderProgressCard(task, detail.steps || []);

    renderApprovals(detail.approvals || []);
    renderDelivery(detail.artifacts?.delivery || task.delivery || null);

    // Conversation thread
    const convo = $("conversation");
    convo.replaceChildren(...(detail.thread || []).map(m => {
      const box = document.createElement("div");
      box.className = "msg " + (m.role === "owner" ? "owner" : "agent");
      const head = document.createElement("span");
      head.className = "msg-head";
      head.textContent = m.role === "owner" ? "You" : [m.role, m.agent].filter(Boolean).join(" · ");
      const body = document.createElement("div");
      body.className = "msg-body";
      body.textContent = m.content;
      box.append(head, body);
      return box;
    }));

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
      ? "Type your answer for this thread…"
      : "Add a follow-up or revision note for this thread…";
    $("sendBtn").textContent = task.stage === "waiting_user" ? "Reply" : "Send";
  }

  async function requestSystemAuth(service, label) {
    if (pendingSignIns.has(service)) return;
    const status = $("systemAuthStatus");
    pendingSignIns.add(service);
    status.textContent = `Preparing ${label} sign-in…`;
    renderHealthModal();
    try {
      const { card } = await apiPost("/api/v2/auth/request", { service, reason: `Sign in to ${label}` });
      await refreshAll();
      status.textContent = card?.alreadyConnected ? `${label} is connected.` : "";
      if (!$("healthModal").open) return;
      const visibleCard = [...$("systemAuthZone").children].find(el => el.dataset.approvalId === card?.id);
      visibleCard?.scrollIntoView({ block: "nearest" });
      if (!card?.alreadyConnected && !visibleCard) {
        status.textContent = `No ${label} sign-in link is available. Try again.`;
      }
    } catch (err) {
      status.textContent = err.message;
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
      const choices = (snap.models || []).filter(m => m.provider === provider);
      const isDisabled = disabledProviders.has(provider) || overrides[provider] === "__disabled__";
      const activeModel = isDisabled
        ? "__disabled__"
        : (overrides[provider]
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
        : (efforts.length ? `Effort scales: ${efforts.join(" · ")}` : "Active");
      left.append(strong, sub);

      const controls = document.createElement("div");
      controls.className = "model-controls";

      const sel = document.createElement("select");
      sel.setAttribute("aria-label", `${h.label} model`);
      const seenIds = new Set();
      for (const m of choices) {
        seenIds.add(m.modelId);
        const label = m.tier === "apex" ? `${m.modelId} (apex)` : m.modelId;
        sel.append(new Option(label, m.modelId));
      }
      if (!isDisabled && activeModel && activeModel !== "__disabled__" && !seenIds.has(activeModel)) {
        sel.append(new Option(activeModel, activeModel));
      }
      sel.append(new Option("Disabled (don't use)", "__disabled__"));
      sel.append(new Option("Add custom model…", "__custom__"));
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
          say(nextModel === "__disabled__" ? `${h.label} disabled.` : `${h.label} set to ${nextModel}.`);
          await refreshAll();
        } catch (err) {
          sel.value = activeModel;
          say(err.message);
        }
      };

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn danger-ghost small";
      removeBtn.textContent = "Remove";
      removeBtn.title = "Remove selected model from choices";
      removeBtn.disabled = isDisabled || !activeModel || activeModel === "__disabled__";
      removeBtn.onclick = async () => {
        if (!activeModel || activeModel === "__disabled__") return;
        try {
          await apiPost("/api/v2/models/remove", { provider, modelId: activeModel });
          say(`Removed ${activeModel} from ${h.label}.`);
          await refreshAll();
        } catch (err) {
          say(err.message);
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
      left.textContent = `${s.label} · ${s.connected ? "Connected" : "Not connected"}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn secondary small";
      btn.textContent = s.connected ? "Reconnect" : "Connect";
      btn.onclick = async () => {
        await apiPost("/api/v2/auth/request", { service: s.id, reason: `Connect ${s.label}` });
        $("healthModal").close();
        await refreshAll();
      };
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
    if (taskId) {
      state.detail = await apiGet(`/api/v2/tasks/${encodeURIComponent(taskId)}`);
    } else {
      state.detail = null;
    }
    renderSidebar();
    renderFocus();
  }

  async function refreshAll() {
    state.snapshot = await apiGet("/api/v2/state");
    const paused = state.snapshot.queuePaused === true;
    $("pauseBanner").hidden = !paused;
    $("pauseBtn").textContent = paused ? "Resume" : "Stop all";

    if (state.focusId === undefined || (state.focusId && !state.snapshot.tasks.some(t => t.id === state.focusId && !t.putAway))) {
      state.focusId = state.snapshot.focusTaskId || null;
    }
    if (state.focusId) {
      state.detail = await apiGet(`/api/v2/tasks/${encodeURIComponent(state.focusId)}`).catch(() => null);
    } else {
      state.detail = null;
    }
    renderSidebar();
    renderFocus();
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
    say("Checking installed CLIs for newer models…");
    await apiPost("/api/v2/models/refresh");
    say("Model catalog updated.");
    await refreshAll();
  };

  $("composer").onsubmit = async e => {
    e.preventDefault();
    const text = $("composerInput").value.trim();
    if (!text || state.sending) return;
    state.sending = true;
    $("sendBtn").disabled = true;
    try {
      if (state.focusId && state.detail?.task) {
        await apiPost(`/api/v2/tasks/${encodeURIComponent(state.focusId)}/reply`, { text });
      } else {
        const res = await apiPost("/api/v2/tasks", { text });
        state.focusId = res.task?.id || null;
      }
      $("composerInput").value = "";
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
        renderProgressCard(state.detail.task, state.detail.steps || []);
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
