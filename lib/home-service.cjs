"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createDoorbellClient, createRinger } = require("../adapters/doorbell.cjs");
const { createNoticeBook } = require("./notices.cjs");
const { watchTaskBoard, defaultCliRunner } = require("./os-runtime.cjs");
const { cachedDetect } = require("./agent-auth.cjs");
const { availabilityFromDetected } = require("./roles.cjs");
const { readSecret, storeSecret } = require("./keyring.cjs");
const { createCloudLink } = require("./cloud-link.cjs");
const { createVapidKeys } = require("./web-push.cjs");
const { SECRET_NAMES } = require("./backend-provision.cjs");
const { createLocalRelay, createRelayServer } = require("./relay-host.cjs");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** One worker per board. The desktop app and the startup service can both ask. */
function acquireServiceLock(boardDir, { pid = process.pid, alive = isProcessAlive } = {}) {
  const file = path.join(boardDir, "service.pid");
  fs.mkdirSync(boardDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: "wx" });
      return { acquired: true, release: () => fs.rmSync(file, { force: true }) };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const holder = Number(fs.readFileSync(file, "utf8"));
      if (Number.isInteger(holder) && holder !== pid && alive(holder)) return { acquired: false, holder };
      fs.rmSync(file, { force: true });
    }
  }
  return { acquired: false };
}

/**
 * A row left "In progress" by a crash or power cut may be half done. Running it
 * again blind could repeat work, so it comes back to the owner as one question.
 */
function recoverInterruptedRows({ board, notices, routerName }) {
  const stuck = board.listTasks({ status: "In progress" });
  for (const row of stuck) {
    board.updateByColumnName({
      taskId: row.ID,
      agent: routerName,
      columns: { Status: "Waiting on User" },
      note: "The computer stopped while this was running.",
    });
    notices.raise({
      row: row.ID,
      kind: "blocked",
      agent: row.To,
      text: `${row.ID} was interrupted when your computer stopped. Run it again?`,
      choices: [{ label: "Run again", value: "retry" }],
      then: { type: "reopen", row: row.ID },
    });
  }
  return stuck.length;
}

function loadVapid({ read, store }) {
  const saved = read(SECRET_NAMES.vapid);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {
      // Replaced below.
    }
  }
  const fresh = createVapidKeys();
  store(SECRET_NAMES.vapid, JSON.stringify(fresh));
  return fresh;
}

/**
 * Everything that keeps the home machine alive to the owner: the board watcher,
 * the heartbeat, the phone connection, and the doorbell.
 */
async function startHomeServices({
  workspaceRoot,
  manifest,
  saveManifest = () => {},
  runner = defaultCliRunner,
  detect = cachedDetect,
  read = readSecret,
  store = storeSecret,
  onDispatch = () => {},
  onStatus = () => {},
  fetchFn = fetch,
  intervalMs,
}) {
  const router = manifest.ideology?.routerFunnel || "Router";
  const board = createLocalBoard({ boardDir: manifest.board?.localDir || path.join(workspaceRoot, "board"), routerName: router });
  board.initBoard();
  const boardDir = path.dirname(board.jsonPath);

  const lock = acquireServiceLock(boardDir);
  if (!lock.acquired) return { started: false, reason: "ALREADY_RUNNING", holder: lock.holder, stop() {} };

  const notices = createNoticeBook({ dir: boardDir });
  recoverInterruptedRows({ board, notices, routerName: router });

  const getAvailability = () => availabilityFromDetected(detect({ workspaceRoot }));
  const stops = [lock.release];
  let doorbell = null;
  let ringer = null;
  let link = null;
  let relayServer = null;

  const backend = manifest.backend || null;
  if (backend) {
    const homeToken = read(SECRET_NAMES.home);
    if (!homeToken) {
      onStatus("Phone connection needs setting up again.");
    } else {
      let relayUrl = backend.relayUrl;
      if (backend.kind === "local") {
        const relay = await createLocalRelay({ file: path.join(boardDir, "relay.json"), phoneToken: read(SECRET_NAMES.phone), homeToken });
        relayServer = createRelayServer({ relay });
        await new Promise(resolve => relayServer.listen(backend.port || 0, "0.0.0.0", resolve));
        relayUrl = `http://127.0.0.1:${relayServer.address().port}`;
        stops.push(() => relayServer.close());
      }
      link = createCloudLink({
        relayUrl,
        homeToken,
        board,
        notices,
        manifest,
        machine: Object.keys(manifest.machines || {})[0] || "primary",
        saveManifest,
        getAvailability,
        fetchFn,
        vapid: backend.kind === "local" ? null : loadVapid({ read, store }),
        onChange: isOnline => onStatus(isOnline ? "Connected to your phone." : "Phone connection lost. Work is queued."),
      });

      const realtimeKey = backend.url ? read(SECRET_NAMES.publishable) : null;
      if (realtimeKey) {
        doorbell = createDoorbellClient({ supabaseUrl: backend.url, apiKey: realtimeKey, onSignal: () => link.tick().catch(() => {}) });
        doorbell.connect();
        ringer = createRinger(doorbell);
        stops.push(() => doorbell.close());
      }
      link.start(intervalMs ? { intervalMs } : undefined);
      stops.push(() => link.stop());
    }
  }

  const watcher = watchTaskBoard({
    workspaceRoot,
    manifest,
    board,
    runner,
    doorbell: ringer,
    onDispatch: res => {
      onDispatch(res);
      link?.tick().catch(() => {});
    },
    detect,
    notices,
  });
  stops.push(() => watcher.close());

  return {
    started: true,
    board,
    notices,
    link,
    watcher,
    relayServer,
    stop() {
      for (const fn of stops.reverse()) fn();
    },
  };
}

module.exports = { acquireServiceLock, recoverInterruptedRows, startHomeServices, isProcessAlive };
