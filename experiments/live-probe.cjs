#!/usr/bin/env node
"use strict";

/**
 * Live test runner for the Muse and Grok Bot connector probe.
 *
 * Test only. It keeps its tokens, its store and a throwaway board in a private folder
 * outside the repo, and never touches the real AI-first OS board, relay or keyring.
 *
 *   node experiments/live-probe.cjs [--port 8787] [--admin-port 8788] [--public-url https://name.example.net]
 *
 * Two servers start:
 *   - the probe (port 8787): the only one ever exposed publicly. Muse uses /requests, /status
 *     and reads /openapi.json; Grok Bot's custom connector uses /mcp.
 *   - admin (port 8788, this computer only): fire the Grok webhook, adopt Muse requests into the
 *     throwaway board, and read what happened. Needs the admin token from the private folder.
 *
 * Token values are written to the private folder and never printed.
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { createConnectorProbe } = require("./personal-connector-probe.cjs");
const { createLocalBoard } = require("../adapters/local-board.cjs");

const DEFAULT_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "ai-first-os-probe");

const ROUTINE_INSTRUCTION = [
  "This routine is a connection test for AI-first OS. When its webhook runs, the request body holds attempt_id, event_id and text.",
  "Call the report_result tool on the AI-first OS probe connector exactly once, with attempt_id and event_id copied unchanged",
  "and result set to text written in capital letters. Do nothing else: no other tools, files, websites or messages.",
].join(" ");

function loadSecrets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "probe-tokens.json");
  if (!fs.existsSync(file)) {
    const token = () => randomBytes(32).toString("base64url");
    fs.writeFileSync(file, JSON.stringify({ muse: token(), grok: token(), admin: token() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (![value.muse, value.grok, value.admin].every(t => typeof t === "string" && t.length >= 32)) {
    throw new Error(`The token file is damaged: ${file}. Delete it to make new test tokens.`);
  }
  return { ...value, file };
}

function loadWebhook(dir) {
  const file = path.join(dir, "grok-webhook.json");
  if (!fs.existsSync(file)) {
    return { error: `Save the routine's webhook as ${file} with {"url": "...", "key": "..."} first.` };
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { error: `${file} is not valid JSON.` }; }
  if (typeof value?.url !== "string" || !/^https:\/\/\S+$/.test(value.url) || typeof value.key !== "string" || !value.key.trim()) {
    return { error: `${file} needs an https "url" and a "key".` };
  }
  return { url: value.url, key: value.key.trim() };
}

const same = (a, b) => timingSafeEqual(createHash("sha256").update(String(a)).digest(), createHash("sha256").update(String(b)).digest());
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => { server.off("error", reject); resolve(server.address().port); });
});

async function startLiveProbe({ dir = DEFAULT_DIR, port = 8787, adminPort = 8788, publicUrl, fetchImpl = fetch } = {}) {
  const secrets = loadSecrets(dir);
  fs.writeFileSync(path.join(dir, "grok-routine-instruction.txt"), ROUTINE_INSTRUCTION + "\n");
  const probe = createConnectorProbe({ file: path.join(dir, "probe-store.json"), museToken: secrets.muse, grokToken: secrets.grok, publicUrl });
  const boardDir = path.join(dir, "throwaway-board");
  const fresh = !fs.existsSync(boardDir);
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  if (fresh) board.initBoard([], { empty: true });
  const fired = [];

  const webhookSender = hook => async ({ attempt_id, text }) => {
    const response = await fetchImpl(hook.url, {
      method: "POST",
      headers: { authorization: "Bearer " + hook.key, "content-type": "application/json" },
      body: JSON.stringify({ attempt_id, event_id: randomUUID(), text, task: ROUTINE_INSTRUCTION }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status };
  };

  const admin = http.createServer(async (req, res) => {
    const route = req.url.split("?")[0];
    if (!same(req.headers["x-probe-admin"] || "", secrets.admin)) return send(res, 401, { error: "Admin token required." });
    try {
      if (req.method === "POST" && route === "/fire") {
        const hook = loadWebhook(dir);
        if (hook.error) return send(res, 400, { error: hook.error });
        const challenge = randomBytes(5).toString("hex");
        const sent = await probe.start(challenge, webhookSender(hook));
        fired.push(sent.attempt_id);
        return send(res, 200, { ...sent, expect: challenge.toUpperCase() });
      }
      if (req.method === "GET" && route === "/attempts") {
        const rows = [];
        for (const id of fired) rows.push({ attempt_id: id, ...(await probe.inspect(id)) });
        return send(res, 200, { attempts: rows });
      }
      if (req.method === "POST" && route === "/sync") {
        const count = await probe.syncRequests({ board, manifest: {} });
        return send(res, 200, { requests: count, board: board.listTasks().map(r => ({ id: r.ID, task: r.Task, from: r.From, to: r.To, status: r.Status })) });
      }
      if (req.method === "POST" && route === "/stop") {
        const id = fired.at(-1);
        return send(res, 200, { stopped: id ? await probe.stop(id) : false, attempt_id: id || null });
      }
      return send(res, 404, { error: "Use POST /fire, GET /attempts, POST /sync or POST /stop." });
    } catch (err) {
      return send(res, 409, { error: String(err?.message || err) });
    }
  });

  const probePort = await listen(probe.server, port, "127.0.0.1");
  const adminPortBound = await listen(admin, adminPort, "127.0.0.1");
  return {
    probeUrl: `http://127.0.0.1:${probePort}`,
    adminUrl: `http://127.0.0.1:${adminPortBound}`,
    dir,
    tokenFile: secrets.file,
    close: () => Promise.all([probe.server, admin].map(s => new Promise(resolve => s.close(resolve)))),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--port") out.port = Number(value);
    else if (flag === "--admin-port") out.adminPort = Number(value);
    else if (flag === "--public-url") out.publicUrl = value;
    else if (flag === "--dir") out.dir = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  return out;
}

if (require.main === module) {
  startLiveProbe(parseArgs(process.argv.slice(2))).then(live => {
    console.log(`Probe (the only part to expose publicly): ${live.probeUrl}`);
    console.log("  Muse: POST /requests, POST /status, description at GET /openapi.json");
    console.log("  Grok Bot connector: POST /mcp");
    console.log(`Admin, this computer only: ${live.adminUrl}  (header x-probe-admin)`);
    console.log(`Private folder (tokens, routine instruction, store, throwaway board): ${live.dir}`);
  }).catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { startLiveProbe, ROUTINE_INSTRUCTION };
