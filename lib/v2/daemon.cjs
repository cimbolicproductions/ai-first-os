"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { defaultProfileDir, loadProfile, saveProfile, listAllProjects, resolveProject, stakesForProject, normalizeProfile } = require("./profile.cjs");
const { createStore } = require("./store.cjs");
const { detectHarnesses, listLiveModels, runHarness } = require("./harnesses.cjs");
const { refreshModelCatalog, seedBaselineModels, classifyModelTier, resolveModelForProvider, PROVIDER_EFFORTS } = require("./model-catalog.cjs");
const { createPipeline } = require("./pipeline.cjs");
const { createRunSpace } = require("./agent-bus.cjs");
const { createAuthBroker, createSecretVault } = require("./auth-broker.cjs");
const { createIntakeBridge, buildConnectorOpenApi, detectGrokBot, createSheetSyncPlugin } = require("./connectors.cjs");
const { createSshWakeWatcher, resolveListenConfig, authenticateRequest, sha256 } = require("./transport.cjs");
const { qrSvg } = require("../qr.cjs");

/**
 * Unified AI-first OS v2 Local Daemon & HTTP/SSE Server.
 *
 * Single source of truth for Desktop, Phone (Tailscale/LAN direct or thin relay),
 * Muse, GrokBot, and SSH wakes.
 */

const UI_DIR = path.join(__dirname, "..", "ui");
const BRAND_LOGO = path.join(__dirname, "..", "..", "assets", "logo-512.png");
const MAX_BODY_BYTES = 256 * 1024;
const HARNESS_STATUS_TTL_MS = 30000;
const MODEL_CATALOG_TTL_MS = 30 * 60 * 1000;
const MODEL_CATALOG_RETRY_MS = 60 * 1000;

function probeHarnessStatus(workspaceRoot) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { detectHarnesses } = require(workerData.modulePath);
      parentPort.postMessage(detectHarnesses({ workspaceRoot: workerData.workspaceRoot }));
    `, { eval: true, workerData: { modulePath: require.resolve("./harnesses.cjs"), workspaceRoot } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => reject(new Error(`Agent status check exited before returning results (${code}).`)));
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Payload too large."), { code: "TOO_LARGE" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(Object.assign(new Error("Invalid JSON."), { code: "BAD_JSON", cause: err })); }
    });
    req.on("error", reject);
  });
}

function renderAuthCaptureHtml({ service, label, approvalId, dashboardUrl, placeholder }) {
  const safeLabel = String(label || service || "Service").replace(/[<>&"]/g, "");
  const safePlaceholder = String(placeholder || "Paste token or key").replace(/[<>&"]/g, "");
  const safeDash = typeof dashboardUrl === "string" && /^https:\/\//.test(dashboardUrl) ? dashboardUrl : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect ${safeLabel} · AI-first OS</title>
<link rel="stylesheet" href="/app.css" />
</head>
<body class="auth-page">
  <main class="auth-card">
    <p class="eyebrow">AI-first OS · Secure Sign-In</p>
    <h1>Connect ${safeLabel}</h1>
    <p class="muted">Saved directly to your computer's OS keyring. Never committed to any repository. Your waiting task resumes automatically.</p>
    ${safeDash ? `<a class="btn secondary" href="${safeDash}" target="_blank" rel="noopener noreferrer">Open ${safeLabel} dashboard</a>` : ""}
    <form id="authForm">
      <input id="secretInput" type="password" autocomplete="off" spellcheck="false" placeholder="${safePlaceholder}" required />
      <button type="submit" class="btn primary">Save &amp; Continue</button>
    </form>
    <p id="authMsg" class="muted" role="status"></p>
  </main>
  <script>
    const token = new URLSearchParams(location.hash.slice(1)).get("t") || localStorage.getItem("aios-token") || "";
    document.getElementById("authForm").onsubmit = async e => {
      e.preventDefault();
      const val = document.getElementById("secretInput").value.trim();
      const msg = document.getElementById("authMsg");
      if (!val) return;
      msg.textContent = "Saving securely…";
      const headers = { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) };
      const res = await fetch("/api/v2/auth/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ approvalId: ${JSON.stringify(approvalId || null)}, service: ${JSON.stringify(service || "")}, secretValue: val }),
      }).then(r => r.json()).catch(() => ({ ok: false, error: "Could not reach OS daemon." }));
      if (res.ok) {
        msg.textContent = "Connected! Your task is resuming automatically. You can close this tab.";
        document.getElementById("secretInput").value = "";
      } else {
        msg.textContent = res.error || "Could not save credential.";
      }
    };
  </script>
</body>
</html>`;
}

function createDaemon({
  profileDir = defaultProfileDir(),
  dbPath = null,
  runsDir = null,
  worktreesDir = null,
  detect = detectHarnesses,
  runner = runHarness,
  runVerification = null,
  listModelsFn = listLiveModels,
  vault = null,
  callGoogleDrive = null,
  now = Date.now,
} = {}) {
  const dir = path.resolve(profileDir);
  fs.mkdirSync(dir, { recursive: true });
  let profile = loadProfile({ profileDir: dir });
  const store = createStore({ dbPath: dbPath || path.join(dir, "os.db"), now });
  seedBaselineModels(store, profile);
  store.recoverInterruptedTasks();

  const resolvedRunsDir = path.resolve(runsDir || path.join(dir, "runs"));
  const resolvedWorktreesDir = path.resolve(worktreesDir || path.join(dir, "worktrees"));
  const secretVault = vault || createSecretVault();

  // Persistent phone & connector tokens (stored in OS keyring; only hashes checked at runtime).
  let phoneToken = secretVault.get("AIOS_V2_PHONE_TOKEN");
  if (!phoneToken) {
    phoneToken = crypto.randomBytes(24).toString("base64url");
    try { secretVault.set("AIOS_V2_PHONE_TOKEN", phoneToken); } catch { /* in-memory fallback for restricted test envs */ }
  }
  const phoneTokenHash = sha256(phoneToken);

  function connectorHashes() {
    const out = {};
    for (const name of ["muse", "grokbot"]) {
      const tok = secretVault.get(`AIOS_V2_CONNECTOR_${name.toUpperCase()}`);
      if (tok) out[name] = sha256(tok);
    }
    return out;
  }

  let baseUrl = "http://127.0.0.1:4318";
  const sseClients = new Set();

  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  }

  const getProfile = () => profile;
  const updateProfile = next => {
    profile = saveProfile(next, { profileDir: dir });
    broadcast({ type: "profile_updated", at: now() });
    return profile;
  };

  let pipeline;
  let harnessStatus = null;
  let pendingHarnessStatus = null;
  let harnessStatusEpoch = 0;
  let antigravityCatalog = null;
  let antigravityRefresh = null;
  const authBroker = createAuthBroker({
    store,
    vault: secretVault,
    getBaseUrl: () => baseUrl,
    onAuthResolved({ taskId, service }) {
      harnessStatus = null;
      harnessStatusEpoch += 1;
      broadcast({ type: "auth_resolved", taskId, service, at: now() });
      if (taskId) {
        const task = store.getTask(taskId);
        if (task && task.stage === "waiting_auth") {
          pipeline.continueTask(taskId, { source: "auth-broker" });
          pipeline.tickQueue().catch(() => {});
        }
      }
    },
  });

  pipeline = createPipeline({
    store,
    getProfile,
    profileDir: dir,
    runsDir: resolvedRunsDir,
    worktreesDir: resolvedWorktreesDir,
    authBroker,
    callGoogleDrive: callGoogleDrive || undefined,
    detect,
    runner,
    runVerification,
    onEvent: ev => broadcast(ev),
    now,
  });

  const intake = createIntakeBridge({
    store,
    pipeline,
    getProfile,
    onTaskQueued: () => { pipeline.tickQueue().catch(() => {}); },
  });

  const sheetSync = createSheetSyncPlugin({ store, getProfile, callGoogleDrive });

  // Optional SSH wake queue watcher (unifies P86-style .wake triggers into the same OS daemon).
  let sshWatcher = null;
  if (profile.transport?.sshWakeDir) {
    sshWatcher = createSshWakeWatcher({
      wakeDir: profile.transport.sshWakeDir,
      onWake(payload) {
        if (payload.taskId) {
          const existing = store.getTask(payload.taskId);
          if (existing) {
            pipeline.continueTask(existing.id, { source: "ssh" });
            pipeline.tickQueue().catch(() => {});
            return { resumed: existing.id };
          }
        }
        if (payload.text) {
          return intake.submit({ connector: "ssh", text: payload.text, projectName: payload.project || null });
        }
        return { ignored: true };
      },
    });
  }

  async function detectSummary() {
    let found;
    if (detect !== detectHarnesses) {
      found = await detect({ workspaceRoot: dir });
    } else if (harnessStatus && now() - harnessStatus.at < HARNESS_STATUS_TTL_MS) {
      found = harnessStatus.agents;
    } else {
      const epoch = harnessStatusEpoch;
      if (pendingHarnessStatus?.epoch !== epoch) {
        const promise = probeHarnessStatus(dir).then(agents => {
          if (harnessStatusEpoch === epoch) harnessStatus = { agents, at: now() };
          return agents;
        }).finally(() => {
          if (pendingHarnessStatus?.epoch === epoch) pendingHarnessStatus = null;
        });
        pendingHarnessStatus = { epoch, promise };
      }
      found = await pendingHarnessStatus.promise;
    }
    return found.map(agent => {
      const q = store.getQuota(agent.id);
      return {
        ...agent,
        quotaStatus: q.status,
        resetAt: q.resetAt,
        quotaReason: q.reason,
      };
    });
  }

  function refreshAntigravityCatalog() {
    if (antigravityRefresh) return antigravityRefresh;
    antigravityRefresh = refreshModelCatalog({
      store, profile, getProfile, providers: ["antigravity"],
      listModelsForProvider: listModelsFn, now,
    }).then(report => {
      antigravityCatalog = { ...report.providerResults[0], checkedAt: now() };
      broadcast({ type: "models_refreshed", at: now() });
      return report;
    }).finally(() => {
      antigravityRefresh = null;
    });
    return antigravityRefresh;
  }

  function checkAntigravityCatalog() {
    const ttl = antigravityCatalog?.status === "updated" ? MODEL_CATALOG_TTL_MS : MODEL_CATALOG_RETRY_MS;
    if (antigravityCatalog && now() - antigravityCatalog.checkedAt < ttl) return;
    if (!antigravityRefresh) refreshAntigravityCatalog().catch(error => {
      antigravityCatalog = { status: "unavailable", checkedAt: now() };
      console.error("Could not update the Antigravity model catalog:", error.code || error.name);
    });
  }

  async function buildStateSnapshot() {
    checkAntigravityCatalog();
    const harnesses = await detectSummary();
    const tasks = store.listTasks({ includePutAway: true });
    const openTasks = tasks.filter(t => !t.putAway);
    let focusTaskId = store.getFocus();
    if (focusTaskId && !openTasks.some(t => t.id === focusTaskId)) focusTaskId = null;
    if (!focusTaskId && openTasks.length) {
      const waiting = openTasks.find(t => t.status === "waiting");
      const running = openTasks.find(t => t.status === "running");
      focusTaskId = (waiting || running || openTasks.at(-1))?.id || null;
    }
    return {
      ok: true,
      owner: profile.owner,
      queuePaused: store.getQueueState().paused,
      focusTaskId,
      tasks,
      approvals: store.listOpenApprovals(),
      quotas: store.listQuotas(),
      models: store.listModels(),
      modelSettings: {
        effortFirst: profile.models?.effortFirst !== false,
        preferBelowApex: profile.models?.preferBelowApex !== false,
        overrides: profile.models?.overrides || {},
        disabledProviders: profile.models?.disabledProviders || [],
        removedModels: profile.models?.removedModels || [],
        providerEfforts: PROVIDER_EFFORTS,
        antigravityCatalog,
        automaticModels: {
          antigravity: resolveModelForProvider({
            store,
            profile: { models: { ...profile.models, overrides: {}, disabledProviders: [] } },
            provider: "antigravity",
            desiredEffort: null,
          }).modelId,
        },
      },
      harnesses,
      projects: listAllProjects(profile),
      services: authBroker.listServiceStatuses(),
      grokbot: detectGrokBot({ profile }),
      museEnabled: profile.connectors?.muse?.enabled === true,
      transport: { mode: profile.transport?.mode || "direct", baseUrl, sshWakeConfigured: Boolean(profile.transport?.sshWakeDir) },
    };
  }

  function getTaskDetails(taskId) {
    const task = store.getTask(taskId);
    if (!task) return null;
    const runSpace = createRunSpace({ runsDir: resolvedRunsDir, taskId });
    return {
      ok: true,
      task,
      thread: store.getThread(taskId),
      bus: store.getBusMessages(taskId),
      steps: runSpace.readSteps(),
      approvals: store.listOpenApprovals({ taskId }),
      artifacts: {
        brief: runSpace.readJson("brief.json"),
        plan: runSpace.readText("plan.md") || null,
        diff: runSpace.readText("diff.patch") || null,
        testLog: runSpace.readText("test.log") || null,
        audit: runSpace.readJson("audit.json"),
        delivery: runSpace.readJson("delivery.json") || task.delivery || null,
      },
    };
  }

  const sendJson = (res, status, data) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    try {
      // Static responsive Web UI (same single app serves Desktop AND Phone!)
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8"));
        return;
      }
      if (req.method === "GET" && pathname === "/app.css") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
        res.end(fs.readFileSync(path.join(UI_DIR, "app.css"), "utf8"));
        return;
      }
      if (req.method === "GET" && pathname === "/app.js") {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        res.end(fs.readFileSync(path.join(UI_DIR, "app.js"), "utf8"));
        return;
      }
      if (req.method === "GET" && pathname === "/brand/logo.png" && fs.existsSync(BRAND_LOGO)) {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
        res.end(fs.readFileSync(BRAND_LOGO));
        return;
      }
      if (req.method === "GET" && pathname === "/auth") {
        const svc = parsedUrl.searchParams.get("service") || "";
        const openAuth = store.listOpenApprovals({ kind: "auth" }).find(a => a.service === svc);
        const spec = authBroker.resolveServiceSpec(svc);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderAuthCaptureHtml({
          service: svc,
          label: spec?.label || svc,
          approvalId: openAuth?.id || null,
          dashboardUrl: spec?.dashboardUrl || openAuth?.meta?.dashboardUrl || "",
          placeholder: spec?.placeholder || openAuth?.meta?.placeholder || "Paste key or token",
        }));
        return;
      }
      if (req.method === "GET" && pathname === "/api/v2/openapi/muse.json") {
        if (!profile.connectors?.muse?.enabled) return sendJson(res, 404, { ok: false, error: "Muse connector is not enabled." });
        return sendJson(res, 200, buildConnectorOpenApi(baseUrl));
      }

      // All API calls require loopback trust OR valid Bearer token (Phone / Muse / GrokBot).
      const auth = authenticateRequest(req, { phoneTokenHash, connectorHashes: connectorHashes() });
      if (!auth.ok) return sendJson(res, 403, { ok: false, error: "Unauthorized", code: auth.reason });

      // External connectors (Muse/GrokBot) can ONLY access /api/v2/intake/* routes!
      const isConnector = auth.caller === "muse" || auth.caller === "grokbot";
      if (isConnector && !pathname.startsWith("/api/v2/intake/")) {
        return sendJson(res, 403, { ok: false, error: "Connectors may only access intake endpoints." });
      }

      // --- Bidirectional Intake Endpoints (Muse, GrokBot, SSH) ---
      if (req.method === "POST" && pathname === "/api/v2/intake/submit") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, intake.submit({
          connector: isConnector ? auth.caller : (body.connector || "muse"),
          text: body.text,
          idempotencyKey: body.idempotencyKey || body.idempotency_key || null,
          projectName: body.projectName || body.project || null,
        }));
      }
      if (req.method === "POST" && pathname === "/api/v2/intake/reply") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, intake.reply({
          connector: isConnector ? auth.caller : (body.connector || "muse"),
          taskId: body.taskId || body.task_id,
          text: body.text,
        }));
      }
      if (req.method === "POST" && pathname === "/api/v2/intake/brief") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, intake.submitBrief({
          connector: isConnector ? auth.caller : (body.connector || "muse"),
          idempotencyKey: body.idempotencyKey || body.idempotency_key || null,
          brief: body.brief,
        }));
      }
      if (req.method === "POST" && pathname === "/api/v2/intake/status") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, intake.status({ taskId: body.taskId || body.task_id }));
      }

      // --- Live Server-Sent Events Stream ---
      if (req.method === "GET" && pathname === "/api/v2/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "connected", at: now() })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // --- Core OS State & Task Routes ---
      if (req.method === "GET" && pathname === "/api/v2/state") {
        return sendJson(res, 200, await buildStateSnapshot());
      }

      const taskMatch = /^\/api\/v2\/tasks\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/.exec(pathname);
      if (taskMatch) {
        const [, id, sub] = taskMatch;
        if (req.method === "GET" && !sub) {
          const detail = getTaskDetails(id);
          return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { ok: false, error: "Task not found." });
        }
        if (req.method === "POST" && sub === "reply") {
          const body = await readJsonBody(req);
          const task = pipeline.replyToTask(id, { reply: body.text, source: auth.caller });
          if (task.id !== id && store.getFocus() === id) store.setFocus(task.id);
          broadcast({ type: task.id === id ? "task_updated" : "task_created", taskId: task.id, at: now() });
          pipeline.tickQueue().catch(() => {});
          return sendJson(res, 200, { ok: true, task });
        }
        if (req.method === "POST" && sub === "continue") {
          const body = await readJsonBody(req);
          const task = pipeline.continueTask(id, { reply: body.note || null, nextAgent: body.nextAgent || null, source: auth.caller });
          broadcast({ type: "task_updated", taskId: id, at: now() });
          pipeline.tickQueue().catch(() => {});
          return sendJson(res, 200, { ok: true, task });
        }
        if (req.method === "POST" && sub === "stop") {
          const stopped = pipeline.stopTask(id);
          broadcast({ type: "task_stopped", taskId: id, at: now() });
          return sendJson(res, 200, { ok: true, stopped });
        }
        if (req.method === "POST" && sub === "put-away") {
          const body = await readJsonBody(req);
          const task = store.updateTask(id, { putAway: body.putAway !== false });
          broadcast({ type: "task_updated", taskId: id, at: now() });
          return sendJson(res, 200, { ok: true, task });
        }
      }

      if (req.method === "POST" && pathname === "/api/v2/tasks") {
        const body = await readJsonBody(req);
        const text = String(body.text || "").trim();
        if (!text) return sendJson(res, 400, { ok: false, error: "Enter a message to start a conversation." });

        const explicitResume = /^(?:please\s+)?(?:continue|resume)\s+[TP]\d+[.!]?$/i.test(text);
        const existingContinue = !body.forceNew && explicitResume ? pipeline.matchContinuationTarget(text) : null;
        if (existingContinue) {
          const resumed = pipeline.continueTask(existingContinue.id, { reply: text, source: auth.caller });
          store.setFocus(resumed.id);
          broadcast({ type: "task_updated", taskId: resumed.id, at: now() });
          pipeline.tickQueue().catch(() => {});
          return sendJson(res, 200, { ok: true, continued: true, task: resumed });
        }

        const projects = listAllProjects(profile);
        const matched = resolveProject(body.projectName || text, projects);
        const task = store.createTask({
          text,
          source: auth.caller,
          projectName: matched?.name || null,
          projectPath: matched?.path || null,
          stakes: body.stakes || (matched ? stakesForProject(matched, profile) : "standard"),
          brief: body.brief || null,
        });
        store.setFocus(task.id);
        broadcast({ type: "task_created", taskId: task.id, at: now() });
        pipeline.tickQueue().catch(() => {});
        return sendJson(res, 200, { ok: true, task });
      }

      if (req.method === "POST" && pathname === "/api/v2/focus") {
        const body = await readJsonBody(req);
        const focus = store.setFocus(body.taskId ?? null);
        return sendJson(res, 200, { ok: true, focus });
      }

      if (req.method === "POST" && pathname === "/api/v2/queue") {
        const body = await readJsonBody(req);
        if (body.paused === true) {
          pipeline.stopAll();
        } else {
          store.setQueuePaused(false);
          pipeline.tickQueue().catch(() => {});
        }
        broadcast({ type: "queue_changed", paused: store.getQueueState().paused, at: now() });
        return sendJson(res, 200, { ok: true, paused: store.getQueueState().paused });
      }

      // --- Approvals, 1-Tap Ship, Model Promotion & Auth ---
      const approvalMatch = /^\/api\/v2\/approvals\/([A-Za-z0-9_-]+)\/answer$/.exec(pathname);
      if (req.method === "POST" && approvalMatch) {
        const body = await readJsonBody(req);
        const answered = store.answerApproval({
          id: approvalMatch[1],
          value: body.value,
          digest: body.digest,
          source: auth.caller,
        });
        let actionResult = null;
        if (answered.kind === "ship") {
          actionResult = await pipeline.executeShipApproval(answered, answered.answerValue);
        } else if (answered.kind === "model_promotion" && answered.answerValue === "promote") {
          const { provider, tier, modelId } = answered.meta || {};
          if (provider && tier && modelId) actionResult = store.setDefaultModel(provider, tier, modelId);
        } else if (answered.kind === "approval" && answered.taskId) {
          if (answered.answerValue === "yes") {
            pipeline.continueTask(answered.taskId, { reply: `Owner approved: ${answered.title}`, source: auth.caller });
            pipeline.tickQueue().catch(() => {});
          } else {
            store.updateTask(answered.taskId, { status: "cancelled", stage: "cancelled" });
          }
        } else if (answered.kind === "auth" && answered.answerValue === "signed_in" && answered.taskId) {
          store.clearQuota(answered.service);
          pipeline.continueTask(answered.taskId, { source: auth.caller });
          pipeline.tickQueue().catch(() => {});
        } else if (answered.kind === "auth" && answered.answerValue === "cancel") {
          authBroker.cancelAuth(answered.id);
        }
        broadcast({ type: "approval_answered", id: answered.id, at: now() });
        return sendJson(res, 200, { ok: true, approval: answered, actionResult });
      }

      if (req.method === "POST" && pathname === "/api/v2/auth/request") {
        const body = await readJsonBody(req);
        const card = await authBroker.requestAuth({
          taskId: body.taskId || null,
          service: body.service,
          reason: body.reason || null,
          replaceApprovalId: body.replaceApprovalId || null,
        });
        broadcast({ type: "auth_requested", service: body.service, at: now() });
        return sendJson(res, 200, { ok: true, card });
      }

      if (req.method === "POST" && pathname === "/api/v2/auth/submit") {
        const body = await readJsonBody(req);
        const resAuth = authBroker.submitSecret({ approvalId: body.approvalId, service: body.service, secretValue: body.secretValue });
        return sendJson(res, 200, resAuth);
      }

      if (req.method === "POST" && pathname === "/api/v2/auth/code") {
        const { approvalId, code } = await readJsonBody(req);
        return sendJson(res, 200, await authBroker.submitCode({ approvalId, code }));
      }

      if (req.method === "POST" && pathname === "/api/v2/models/refresh") {
        const detected = (await detectSummary()).filter(a => a.installed && a.headless);
        const [antigravity, other] = await Promise.all([
          refreshAntigravityCatalog(),
          refreshModelCatalog({
            store, profile, providers: detected.map(a => a.id).filter(id => id !== "antigravity"),
            listModelsForProvider: provider => listModelsFn(provider, { detect: () => detected }), now,
          }),
        ]);
        const report = {
          discoveredNew: [...antigravity.discoveredNew, ...other.discoveredNew],
          promoted: other.promoted,
          pendingApprovals: other.pendingApprovals,
          providerResults: [...antigravity.providerResults, ...other.providerResults],
        };
        broadcast({ type: "models_refreshed", at: now() });
        return sendJson(res, 200, { ok: true, ...report, models: store.listModels() });
      }

      if (req.method === "POST" && pathname === "/api/v2/models/select") {
        const body = await readJsonBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        const modelId = String(body.modelId || "").trim();
        if (!PROVIDER_EFFORTS[provider] || !modelId) {
          return sendJson(res, 400, { ok: false, error: "Valid provider and modelId are required." });
        }
        const overrides = { ...(profile.models?.overrides || {}) };
        const disabled = new Set(profile.models?.disabledProviders || []);
        const removed = new Set(profile.models?.removedModels || []);
        if (modelId === "__disabled__") {
          disabled.add(provider);
          delete overrides[provider];
        } else if (provider === "antigravity") {
          disabled.delete(provider);
          if (modelId === "__automatic__") {
            for (const key of Object.keys(overrides)) {
              if (key === provider || key.startsWith(`${provider}:`)) delete overrides[key];
            }
          } else {
            const available = store.listModels({ provider }).some(m => m.status === "listed" && m.modelId === modelId);
            if (!available) return sendJson(res, 400, { ok: false, error: "That model isn’t listed for this Antigravity account. Check for current models first." });
            overrides[provider] = modelId;
          }
        } else if (modelId === "__automatic__") {
          return sendJson(res, 400, { ok: false, error: "Automatic selection is available for Antigravity." });
        } else {
          disabled.delete(provider);
          removed.delete(`${provider}:${modelId}`);
          const tier = classifyModelTier(provider, modelId);
          store.upsertModel({
            provider,
            modelId,
            tier,
            effortLevels: PROVIDER_EFFORTS[provider],
            status: "promoted",
            isDefault: true,
          });
          store.setDefaultModel(provider, tier, modelId);
          overrides[provider] = modelId;
        }
        updateProfile({
          ...profile,
          models: {
            ...(profile.models || {}),
            effortFirst: true,
            overrides,
            disabledProviders: [...disabled],
            removedModels: [...removed],
          },
        });
        return sendJson(res, 200, { ok: true, provider, modelId, models: store.listModels() });
      }

      if (req.method === "POST" && pathname === "/api/v2/models/remove") {
        const body = await readJsonBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        const modelId = String(body.modelId || "").trim();
        if (!PROVIDER_EFFORTS[provider] || !modelId || ["__disabled__", "__automatic__"].includes(modelId)) {
          return sendJson(res, 400, { ok: false, error: "Valid provider and modelId are required." });
        }
        store.removeModel(provider, modelId);
        const removed = new Set(profile.models?.removedModels || []);
        removed.add(`${provider}:${modelId}`);
        const overrides = { ...(profile.models?.overrides || {}) };
        const disabled = new Set(profile.models?.disabledProviders || []);
        const remaining = store.listModels({ provider }).filter(m => !removed.has(`${provider}:${m.modelId}`));
        if (provider === "antigravity") {
          for (const key of Object.keys(overrides)) {
            if ((key === provider || key.startsWith(`${provider}:`)) && overrides[key] === modelId) delete overrides[key];
          }
        } else if (overrides[provider] === modelId || !remaining.length) {
          if (remaining.length) {
            overrides[provider] = remaining[0].modelId;
            store.setDefaultModel(provider, remaining[0].tier, remaining[0].modelId);
          } else {
            delete overrides[provider];
            disabled.add(provider);
          }
        }
        updateProfile({
          ...profile,
          models: {
            ...(profile.models || {}),
            overrides,
            disabledProviders: [...disabled],
            removedModels: [...removed],
          },
        });
        return sendJson(res, 200, { ok: true, provider, removedModelId: modelId, models: store.listModels() });
      }

      if (req.method === "POST" && pathname === "/api/v2/profile/project-stakes") {
        const body = await readJsonBody(req);
        const projects = listAllProjects(profile);
        const target = resolveProject(body.name || "", projects);
        if (!target) return sendJson(res, 404, { ok: false, error: "Project not found." });
        const stakes = ["critical", "standard", "sandbox"].includes(body.stakes) ? body.stakes : target.stakes;
        const mergePolicy = ["ask", "auto"].includes(body.mergePolicy) ? body.mergePolicy : (stakes === "sandbox" ? "auto" : "ask");
        const nextList = [...(profile.projects || [])];
        const idx = nextList.findIndex(p => path.resolve(p.path).toLowerCase() === path.resolve(target.path).toLowerCase());
        const updated = { ...target, stakes, mergePolicy };
        if (idx >= 0) nextList[idx] = updated;
        else nextList.push(updated);
        updateProfile({ ...profile, projects: nextList });
        return sendJson(res, 200, { ok: true, project: updated });
      }

      if (req.method === "POST" && pathname === "/api/v2/connectors/token") {
        const body = await readJsonBody(req);
        const name = ["muse", "grokbot"].includes(body.connector) ? body.connector : null;
        if (!name) return sendJson(res, 400, { ok: false, error: "Connector must be muse or grokbot." });
        const token = crypto.randomBytes(24).toString("base64url");
        secretVault.set(`AIOS_V2_CONNECTOR_${name.toUpperCase()}`, token);
        const nextConnectors = { ...profile.connectors, [name]: { ...(profile.connectors?.[name] || {}), enabled: true } };
        updateProfile({ ...profile, connectors: nextConnectors });
        return sendJson(res, 200, {
          ok: true,
          connector: name,
          token,
          openApiUrl: name === "muse" ? `${baseUrl}/api/v2/openapi/muse.json` : null,
        });
      }

      if (req.method === "GET" && pathname === "/api/v2/phone/pairing") {
        const hostForPhone = profile.transport?.tailscaleHost || baseUrl.replace(/^https?:\/\//, "").split(":")[0];
        const port = server.address()?.port || profile.transport?.port || 4318;
        const directUrl = `http://${hostForPhone}:${port}/#t=${encodeURIComponent(phoneToken)}`;
        return sendJson(res, 200, {
          ok: true,
          url: directUrl,
          qr: qrSvg(directUrl),
          mode: profile.transport?.tailscaleHost ? "tailscale-direct" : "local",
        });
      }

      sendJson(res, 404, { ok: false, error: "Not found." });
    } catch (err) {
      const status = err.code === "TOO_LARGE" ? 413 : ["REPLY_IN_PROGRESS", "APPROVAL_PENDING"].includes(err.code) ? 409 : 400;
      sendJson(res, status, { ok: false, error: err.message, code: err.code });
    }
  });

  let queueTimer = null;
  let sheetTimer = null;

  async function start({ host = null, port = null } = {}) {
    const cfg = resolveListenConfig(profile);
    const bindHost = host || cfg.host;
    const bindPort = port !== null ? port : cfg.port;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindPort, bindHost, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    baseUrl = `http://${bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost}:${addr.port}`;
    checkAntigravityCatalog();
    sshWatcher?.start();
    queueTimer = setInterval(() => { pipeline.tickQueue().catch(() => {}); }, 4000);
    queueTimer.unref?.();
    if (profile.connectors?.sheetsSync?.enabled) {
      sheetTimer = setInterval(() => { sheetSync.syncOnce().catch(() => {}); }, 30000);
      sheetTimer.unref?.();
    }
    return { url: baseUrl, port: addr.port, host: bindHost, phoneToken };
  }

  async function stop() {
    if (queueTimer) clearInterval(queueTimer);
    if (sheetTimer) clearInterval(sheetTimer);
    sshWatcher?.stop();
    authBroker.stop();
    for (const res of sseClients) {
      try { res.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    await new Promise(resolve => server.close(() => resolve()));
    await antigravityRefresh?.catch(() => {});
    store.close();
  }

  return {
    server,
    store,
    pipeline,
    authBroker,
    intake,
    sheetSync,
    getProfile,
    updateProfile,
    buildStateSnapshot,
    getTaskDetails,
    start,
    stop,
  };
}

module.exports = { createDaemon, renderAuthCaptureHtml };
