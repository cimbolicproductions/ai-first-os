"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { startLiveProbe } = require("./live-probe.cjs");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-live-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const post = async (url, body, headers = {}) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return [response.status, response.status === 202 ? null : await response.json()];
};

test("the full Grok loop over real HTTP: webhook out, MCP result back, with a stand-in for Grok Bot", async t => {
  const dir = tempDir(t);
  const live = await startLiveProbe({ dir, port: 0, adminPort: 0, publicUrl: "https://probe.example.net" });
  t.after(live.close);
  const tokens = JSON.parse(fs.readFileSync(live.tokenFile, "utf8"));
  const adminHeaders = { "x-probe-admin": tokens.admin };
  let probeUrl = live.probeUrl;

  // Only the probe's routes are served: no phone page, and the description holds no secret.
  assert.equal((await fetch(live.probeUrl + "/")).status, 404);
  const doc = await (await fetch(live.probeUrl + "/openapi.json")).json();
  assert.deepEqual(Object.keys(doc.paths), ["/requests", "/status"]);
  assert.equal(doc.servers[0].url, "https://probe.example.net");
  for (const value of Object.values(tokens)) assert.equal(JSON.stringify(doc).includes(value), false);

  // Admin needs its token, and firing without a saved webhook says what to do.
  assert.equal((await post(live.adminUrl + "/fire", {}))[0], 401);
  const [noHook, noHookBody] = await post(live.adminUrl + "/fire", {}, adminHeaders);
  assert.equal(noHook, 400);
  assert.match(noHookBody.error, /grok-webhook\.json/);

  // A stand-in for a Grok Bot routine: answers 200 at once (a run started), then calls back over MCP.
  const hookKey = randomUUID();
  const calls = [];
  const grok = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer " + hookKey) { res.writeHead(401); return res.end(); }
      const body = JSON.parse(raw);
      calls.push(body);
      res.writeHead(200); res.end();
      setTimeout(async () => {
        const auth = { authorization: "Bearer " + tokens.grok, accept: "application/json, text/event-stream" };
        await post(probeUrl + "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok-stand-in", version: "1" } } }, auth);
        await post(probeUrl + "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, auth);
        await post(probeUrl + "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report_result",
          arguments: { attempt_id: body.attempt_id, event_id: body.event_id, result: body.text.toUpperCase() } } }, auth);
      }, 20);
    });
  });
  await new Promise(resolve => grok.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => grok.close(resolve)));
  // The real webhook must be https; the stand-in is plain http on this computer, so a fetch stand-in rewrites it.
  fs.writeFileSync(path.join(dir, "grok-webhook.json"), JSON.stringify({ url: "https://grok.example.net/hook", key: hookKey }));
  await live.close();
  const relive = await startLiveProbe({ dir, port: 0, adminPort: 0,
    fetchImpl: (url, init) => fetch(url.replace("https://grok.example.net/hook", `http://127.0.0.1:${grok.address().port}/`), init) });
  t.after(relive.close);
  probeUrl = relive.probeUrl;

  const [fireStatus, fired] = await post(relive.adminUrl + "/fire", {}, adminHeaders);
  assert.equal(fireStatus, 200);
  assert.equal(fired.delivery, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text.toUpperCase(), fired.expect);
  assert.match(calls[0].task, /report_result/);
  const answered = async index => {
    let attempt;
    for (let i = 0; i < 50 && !attempt?.callback; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      attempt = (await (await fetch(relive.adminUrl + "/attempts", { headers: adminHeaders })).json()).attempts[index];
    }
    return attempt;
  };
  const first = await answered(0);
  assert.equal(first.callback.result, fired.expect);
  assert.equal(first.callback.event_id, calls[0].event_id);
  // The first attempt is answered, so a new one may start, and it is answered on its own.
  const [, again] = await post(relive.adminUrl + "/fire", {}, adminHeaders);
  assert.equal(again.delivery, "accepted");
  assert.notEqual(again.attempt_id, fired.attempt_id);
  assert.equal((await answered(1)).callback.result, again.expect);
});

test("the Muse loop over real HTTP: submit, adopt into the throwaway board, read the status", async t => {
  const dir = tempDir(t);
  const live = await startLiveProbe({ dir, port: 0, adminPort: 0 });
  t.after(live.close);
  const tokens = JSON.parse(fs.readFileSync(live.tokenFile, "utf8"));
  const muse = { authorization: "Bearer " + tokens.muse };
  const body = { text: "AIOS probe museround1", idempotency_key: randomUUID() };
  const [created, receipt] = await post(live.probeUrl + "/requests", body, muse);
  assert.equal(created, 201);
  assert.equal(receipt.state, "queued");
  assert.equal((await post(live.probeUrl + "/requests", body, { authorization: "Bearer " + tokens.grok }))[0], 401);
  const [, synced] = await post(live.adminUrl + "/sync", {}, { "x-probe-admin": tokens.admin });
  assert.deepEqual(synced.board.map(r => [r.task, r.from, r.status]), [[body.text, "Muse", "Open"]]);
  const [, status] = await post(live.probeUrl + "/status", { request_id: receipt.request_id }, muse);
  assert.deepEqual([status.state, status.task_id], ["Open", synced.board[0].id]);
});

test("the runner prints where things are but never a token", async t => {
  const dir = tempDir(t);
  const child = spawn(process.execPath, [path.join(__dirname, "live-probe.cjs"), "--port", "0", "--admin-port", "0", "--dir", dir]);
  t.after(() => child.kill());
  let out = "";
  await new Promise((resolve, reject) => {
    child.stdout.on("data", c => { out += c; if (/Private folder/.test(out)) resolve(); });
    child.on("exit", code => reject(new Error("runner exited " + code)));
  });
  const tokens = JSON.parse(fs.readFileSync(path.join(dir, "probe-tokens.json"), "utf8"));
  for (const value of Object.values(tokens)) assert.equal(out.includes(value), false);
  assert.match(out, /Probe \(the only part to expose publicly\): http:\/\/127\.0\.0\.1:\d+/);
  assert.ok(fs.existsSync(path.join(dir, "grok-routine-instruction.txt")));
});
