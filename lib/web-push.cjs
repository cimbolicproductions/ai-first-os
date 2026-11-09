"use strict";

const crypto = require("node:crypto");

/**
 * Web Push with an empty body. The push only wakes the phone; the page then reads
 * the words over its own connection, so no task text passes through a push service.
 */
function createVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

function privateKeyObject({ publicKey, privateKey }) {
  const pub = Buffer.from(publicKey, "base64url");
  return crypto.createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: privateKey,
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33, 65).toString("base64url"),
    },
  });
}

function vapidHeader({ endpoint, vapid, subject = "https://github.com/cimbolicproductions/ai-first-os", nowSeconds = Math.floor(Date.now() / 1000) }) {
  const encode = v => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key: privateKeyObject(vapid), dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${vapid.publicKey}`;
}

async function sendEmptyPush({ endpoint, vapid, fetchFn = fetch }) {
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/127\.0\.0\.1[:/]/.test(endpoint)) {
    return { sent: false, reason: "insecure_endpoint" };
  }
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { TTL: "86400", urgency: "high", authorization: vapidHeader({ endpoint, vapid }) },
  });
  return { sent: res.ok, status: res.status };
}

module.exports = { createVapidKeys, vapidHeader, sendEmptyPush };
