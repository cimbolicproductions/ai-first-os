"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Pluggable Transport Layer:
 *  1. Direct Tailscale / LAN HTTP+SSE binding (personal zero-latency default)
 *  2. SSH Wake Queue Watcher (unifies P86-style SSH .wake drops into the OS daemon)
 *  3. Token verification helper for remote phone & connector calls
 */

/**
 * Watches an SSH wake queue directory (e.g. a restricted SSH account that can
 * only write .wake files) and converts each valid wake into an OS daemon task
 * or resumes an existing task, archiving processed files atomically.
 */
function createSshWakeWatcher({ wakeDir, archiveDir = null, onWake, pollMs = 5000, onError = () => {} }) {
  const dir = path.resolve(wakeDir);
  const archive = path.resolve(archiveDir || path.join(dir, "processed"));
  let watcher = null;
  let timer = null;
  let draining = false;

  function parseWakeFile(filePath, filename) {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    // Supports either JSON payload {"taskId":"P12"} / {"text":"...","project":"..."} or plain "P12" / prompt text.
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      } catch { /* fall through to plain text */ }
    }
    const idMatch = /^(?:[A-Z]\d+)$/i.exec(raw);
    if (idMatch) return { taskId: raw.toUpperCase() };
    const fromName = /-(P\d+|T\d+)\.wake$/i.exec(filename);
    if (!raw && fromName) return { taskId: fromName[1].toUpperCase() };
    return raw ? { text: raw } : null;
  }

  async function drainOnce() {
    if (draining || !fs.existsSync(dir)) return [];
    draining = true;
    const processed = [];
    try {
      const files = fs.readdirSync(dir)
        .filter(name => name.endsWith(".wake"))
        .sort();
      for (const name of files) {
        const full = path.join(dir, name);
        let payload = null;
        try {
          if (!fs.statSync(full).isFile()) continue;
          payload = parseWakeFile(full, name);
        } catch {
          continue;
        }
        fs.mkdirSync(archive, { recursive: true });
        const dest = path.join(archive, `${Date.now()}-${name}`);
        try {
          fs.renameSync(full, dest);
        } catch {
          continue;
        }
        if (payload) {
          const outcome = await Promise.resolve(onWake({ ...payload, wakeFile: name }));
          processed.push({ file: name, payload, outcome });
        }
      }
    } catch (err) {
      onError(err);
    } finally {
      draining = false;
    }
    return processed;
  }

  function start() {
    fs.mkdirSync(dir, { recursive: true });
    try {
      watcher = fs.watch(dir, (_, filename) => {
        if (filename && String(filename).endsWith(".wake")) drainOnce().catch(onError);
      });
      watcher.on("error", onError);
    } catch { /* fallback to polling */ }
    timer = setInterval(() => { drainOnce().catch(onError); }, pollMs);
    timer.unref?.();
    drainOnce().catch(onError);
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (watcher) watcher.close();
    timer = null;
    watcher = null;
  }

  return { drainOnce, start, stop };
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function constantTimeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function resolveListenConfig(profile) {
  const t = profile?.transport || {};
  const port = Number.isInteger(t.port) && t.port >= 0 ? t.port : 4318;
  // When tailscaleHost is set (or host is explicitly set), listen on 0.0.0.0 so both
  // desktop loopback (127.0.0.1) and remote Tailscale phone (Bearer-authenticated) work.
  const host = typeof t.host === "string" && t.host.trim()
    ? t.host.trim()
    : (typeof t.tailscaleHost === "string" && t.tailscaleHost.trim() ? "0.0.0.0" : "127.0.0.1");
  return { host, port, mode: t.mode || "direct" };
}

/**
 * Authenticates incoming requests:
 * - Same-machine loopback requests with matching Origin/Host pass as "desktop".
 * - Remote (Tailscale/phone) or external connector calls require a valid Bearer token hash!
 */
function authenticateRequest(req, { phoneTokenHash = null, connectorHashes = {} } = {}) {
  const auth = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() || null;

  if (bearer) {
    const hash = sha256(bearer);
    if (phoneTokenHash && constantTimeHexEqual(hash, phoneTokenHash)) {
      return { ok: true, caller: "phone" };
    }
    for (const [name, expectedHash] of Object.entries(connectorHashes || {})) {
      if (expectedHash && constantTimeHexEqual(hash, expectedHash)) {
        return { ok: true, caller: name };
      }
    }
    return { ok: false, reason: "INVALID_TOKEN" };
  }

  // Loopback desktop trust check (prevents cross-origin CSRF from random web tabs).
  const host = String(req.headers.host || "");
  const isLoopbackHost = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host);
  const remote = String(req.socket?.remoteAddress || "");
  const isLoopbackRemote = !remote || remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLoopbackHost || !isLoopbackRemote) {
    return { ok: false, reason: "TOKEN_REQUIRED" };
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) {
    return { ok: false, reason: "BAD_ORIGIN" };
  }
  return { ok: true, caller: "desktop" };
}

module.exports = {
  createSshWakeWatcher,
  sha256,
  constantTimeHexEqual,
  resolveListenConfig,
  authenticateRequest,
};
