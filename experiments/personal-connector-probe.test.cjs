"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createConnectorProbe } = require("./personal-connector-probe.cjs");

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-connector-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = { muse: randomUUID(), grok: randomUUID() };
  let now = Date.now();
  const open = async (grokToken = tokens.grok) => {
    const probe = createConnectorProbe({ file: path.join(dir, "probe.json"), museToken: tokens.muse, grokToken, now: () => now });
    await new Promise(resolve => probe.server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + probe.server.address().port;
    const call = async (route, body, token, extra = {}) => {
      const response = await fetch(base + route, { method: "POST", headers: {
        authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra,
      }, body: JSON.stringify(body) });
      return [response.status, response.status === 202 ? null : await response.json()];
    };
    const rpc = async (method, params, token = tokens.grok) =>
      call("/mcp", { jsonrpc: "2.0", id: 1, method, params }, token);
    const close = () => new Promise(resolve => probe.server.close(resolve));
    t.after(close);
    return { ...probe, call, rpc, close };
  };
  return { dir, tokens, open, advance: ms => { now += ms; } };
}

test("Muse HTTP intake survives a restart and concurrent retries adopt exactly one request", async t => {
  const { dir, tokens, open } = await setup(t);
  const first = await open();
  const body = { text: "AIOS probe qwerty123", idempotency_key: randomUUID() };
  const sends = await Promise.all(Array.from({ length: 12 }, () => first.call("/requests", body, tokens.muse)));
  assert.equal(sends.filter(([code]) => code === 201).length, 1);
  assert.equal(new Set(sends.map(([, value]) => value.request_id)).size, 1);
  assert.equal(sends[0][1].state, "queued");
  assert.equal((await first.call("/requests", { ...body, text: "AIOS probe othertext" }, tokens.muse))[0], 409);
  assert.equal((await first.call("/requests", body, tokens.grok))[0], 401);
  await first.close();
  const reopened = await open();
  const request_id = sends[0][1].request_id;
  assert.equal((await reopened.call("/status", { request_id }, tokens.muse))[1].state, "queued");
  assert.equal((await reopened.call("/status", { request_id }, tokens.grok))[0], 401);
  assert.equal((await reopened.call("/status", { request_id: randomUUID() }, tokens.muse))[0], 404);
  const board = createLocalBoard({ boardDir: path.join(dir, "board") });
  board.initBoard([], { empty: true });
  await Promise.all(Array.from({ length: 4 }, () => reopened.syncRequests({ board, manifest: {} })));
  const [row] = board.listTasks();
  assert.equal(board.listTasks().length, 1);
  assert.deepEqual([row.Task, row.From, row.To], [body.text, "Muse", "muse"]);
  assert.equal(board.getMeta(row.ID).sourceRequest, request_id);
  const [, status] = await reopened.call("/status", { request_id }, tokens.muse);
  assert.deepEqual([status.state, status.task_id], ["Open", row.ID]);
  assert.match(status.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("a simulated Grok routine negotiates MCP and stores its result even if the webhook acknowledgment is lost", async t => {
  const { tokens, open } = await setup(t);
  const probe = await open();
  const init = await probe.rpc("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" }, capabilities: {} });
  assert.equal(init[1].result.protocolVersion, "2025-11-25");
  const initialized = await probe.call("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, tokens.grok);
  assert.deepEqual(initialized, [202, null]);
  assert.equal((await probe.rpc("tools/list"))[1].result.tools[0].name, "report_result");
  assert.equal((await probe.rpc("tools/list", {}, tokens.muse))[0], 401);
  let callback;
  const event_id = randomUUID();
  const sent = await probe.start("a1b2c3", async ({ attempt_id, text }) => {
    callback = { name: "report_result", arguments: { attempt_id, event_id, result: text.toUpperCase() } };
    assert.equal((await probe.rpc("tools/call", callback))[1].result.isError, undefined);
    throw new Error("Simulated connection drop after delivery");
  });
  assert.equal(sent.delivery, "uncertain");
  await probe.close();
  const resumed = await open();
  assert.equal((await resumed.inspect(sent.attempt_id)).callback.result, "A1B2C3");
  assert.equal((await resumed.rpc("tools/call", callback))[1].result.isError, undefined);
  const conflicting = { ...callback, arguments: { ...callback.arguments, result: "different" } };
  assert.equal((await resumed.rpc("tools/call", conflicting))[1].result.isError, true);
});

test("pending attempts cannot be resent, and expired, stopped, and revoked connections cannot submit a result", async t => {
  const { tokens, open, advance } = await setup(t);
  const probe = await open();
  const report = async ({ attempt_id, text }) => probe.rpc("tools/call", {
    name: "report_result", arguments: { attempt_id, event_id: randomUUID(), result: text.toUpperCase() },
  });
  const first = await probe.start("a1b2c3", async () => ({ status: 200 }));
  assert.equal(first.delivery, "accepted");
  assert.equal((await probe.inspect(first.attempt_id)).callback, undefined);
  await assert.rejects(probe.start("f1e2d3", async () => assert.fail("duplicate dispatch")), /still outstanding/);
  await probe.stop(first.attempt_id);
  assert.equal((await report(first))[1].result.isError, true);
  const second = await probe.start("f1e2d3", async () => ({ status: 200 }));
  advance(300001);
  assert.equal((await report(second))[1].result.isError, true);
  assert.equal((await report({ attempt_id: randomUUID(), text: "f1e2d3" }))[1].result.isError, true);
  await probe.close();
  const rotated = await open(randomUUID());
  assert.equal((await rotated.rpc("tools/list", {}, tokens.grok))[0], 401);
});
