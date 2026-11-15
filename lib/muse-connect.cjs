"use strict";

const { sha256Hex } = require("./relay-core.cjs");
const { newToken } = require("./cloud-link.cjs");
const { SECRET_NAMES, updateRelay } = require("./backend-provision.cjs");

/**
 * Connect Muse: the owner's own Muse sends requests to their board and checks on them,
 * through the online phone connection they already have. Muse has no sign-in an app can
 * start, so the owner asks Muse to create a custom connector and pastes one key into it.
 *
 * The key is made here, shown once, and only its hash leaves this computer. It is never
 * saved here: lost, it is replaced with New key, which also stops the old one working.
 */

function museSentence(baseUrl) {
  return `Create a custom connector named "AI-first OS". Its API description is at ${baseUrl}/museapi and it uses a bearer token.`;
}

function createMuseConnection({ readSecret, saveManifest, product = null, fetchFn = fetch, update = updateRelay, now = () => new Date() }) {
  const session = {};

  function onlineRelay(manifest) {
    const backend = manifest?.backend;
    if (!backend || backend.kind === "local" || typeof backend.relayUrl !== "string" || !/^https:\/\//.test(backend.relayUrl)) return null;
    return backend.relayUrl.replace(/\/+$/, "");
  }

  async function homeCall(relay, body) {
    const res = await fetchFn(`${relay}/v1/connector`, {
      method: "POST",
      headers: { authorization: `Bearer ${readSecret(SECRET_NAMES.home)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  function status(manifest) {
    const muse = manifest?.connectors?.muse;
    return { available: Boolean(onlineRelay(manifest)), connected: Boolean(muse), since: muse?.since || null };
  }

  /** Makes a new key, which replaces any earlier one. With updateFirst, brings an older relay up to date first. */
  async function connect(manifest, { updateFirst = false } = {}) {
    const relay = onlineRelay(manifest);
    if (!relay || !readSecret(SECRET_NAMES.home)) {
      return { ok: false, code: "PHONE_NEEDED", message: "Muse reaches your board through your online phone connection. Connect your phone first, then come back here." };
    }
    if (updateFirst) {
      let updated;
      try {
        updated = await update({ product, ref: manifest.backend.ref, session, fetchFn });
      } catch {
        updated = { ok: false };
      }
      if (!updated.ok) return { ok: false, code: updated.code || "UPDATE_FAILED", message: updated.message || "The update did not finish. Try again." };
    }
    const key = newToken();
    let answer;
    try {
      answer = await homeCall(relay, { name: "muse", tokenHash: await sha256Hex(key), baseUrl: `${relay}/v1` });
    } catch {
      return { ok: false, code: "OFFLINE", message: "Could not reach your phone connection. Check the internet and try again." };
    }
    // An older relay does not know this route yet.
    if (answer.status === 403 && answer.data.code === "FORBIDDEN") {
      return { ok: false, code: "RELAY_UPDATE_NEEDED", message: "Your phone connection needs a one-time update for Muse. You sign in to Supabase once, and your phone stays connected." };
    }
    if (answer.status !== 200 || answer.data.ok !== true) {
      return { ok: false, code: answer.data.code || "CONNECT_FAILED", message: "Muse could not be connected. Try again." };
    }
    manifest.connectors = { ...(manifest.connectors || {}), muse: { since: new Date(now()).toISOString() } };
    saveManifest(manifest);
    return { ok: true, key, sentence: museSentence(`${relay}/v1`), descriptionUrl: `${relay}/v1/museapi` };
  }

  /** Stops Muse's key working at once. */
  async function disconnect(manifest) {
    const relay = onlineRelay(manifest);
    if (relay && readSecret(SECRET_NAMES.home)) {
      let answer;
      try {
        answer = await homeCall(relay, { name: "muse", tokenHash: null });
      } catch {
        answer = null;
      }
      // 403 is an older relay that never had a key to turn off.
      if (!answer || (answer.status !== 200 && !(answer.status === 403 && answer.data.code === "FORBIDDEN"))) {
        return { ok: false, message: "Could not reach your phone connection, so Muse's key still works. Try again." };
      }
    }
    if (manifest.connectors) delete manifest.connectors.muse;
    saveManifest(manifest);
    return { ok: true };
  }

  return { status, connect, disconnect };
}

module.exports = { createMuseConnection, museSentence };
