"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRelay, sha256Hex } = require("../lib/relay-core.cjs");
const { createCloudLink } = require("../lib/cloud-link.cjs");

function memoryStore() {
  const items = [];
  const state = new Map();
  return {
    async add(kind, body) {
      const item = { id: items.length + 1, kind, body };
      items.push(item);
      return item;
    },
    async list(kinds) { return items.filter(item => !item.consumed && kinds.includes(item.kind)); },
    async consume(ids) { for (const item of items) if (ids.includes(item.id)) item.consumed = true; },
    async getState(key) { return state.get(key); },
    async setState(key, value) { state.set(key, value); },
  };
}

async function setup() {
  const store = memoryStore();
  const rings = [];
  const relay = createRelay({
    store,
    phoneTokenHash: await sha256Hex("test-phone"),
    homeTokenHash: await sha256Hex("test-home"),
    ring: async signal => { rings.push(signal); },
  });
  const call = (method, route, body, token = "test-phone") => relay.handle({
    method, path: "/v1/" + route, headers: { authorization: "Bearer " + token }, body,
  });
  return { store, rings, call };
}

test("phone Sheet operations require the phone token and a configured home, and use a separate queue", async () => {
  const { store, rings, call } = await setup();
  const operation = { requestId: "1".repeat(32), action: "add", tasks: ["Replace the filter"] };
  assert.equal((await call("POST", "sheet", operation, "wrong")).status, 401);
  assert.equal((await call("POST", "sheet", operation, "test-home")).status, 403);
  assert.equal((await call("POST", "sheet", operation)).body.code, "SHEET_UNAVAILABLE");
  assert.equal((await call("POST", "heartbeat", { sheetTasks: true }, "test-home")).status, 200);
  assert.equal((await call("POST", "sheet", { ...operation, action: "delete" })).status, 400);
  assert.equal((await call("POST", "sheet", operation)).body.requestId, operation.requestId);
  assert.equal((await call("POST", "sheet", operation)).status, 200);
  assert.equal((await call("POST", "sheet", { ...operation, tasks: ["A changed retry"] })).body.code, "SHEET_REQUEST_CONFLICT");
  assert.equal((await call("POST", "sheetstatus", operation)).body.state, "queued");
  assert.equal((await call("POST", "receipt", { requestId: operation.requestId, success: true, message: "Fake save" })).status, 403);
  assert.equal((await store.list(["request"])).length, 0, "task text must not run through the agent queue");
  assert.equal((await store.list(["sheet"])).length, 1);
  assert.deepEqual(Object.keys(rings[0]).sort(), ["event", "from", "machine", "row"]);
  assert.doesNotMatch(JSON.stringify(rings), /Replace the filter/);
});

test("phone waits for confirmed Sheet writes and retries an uncertain write with the same request ID", async () => {
  const { call } = await setup();
  const writes = [];
  const notes = [];
  const task = { id: "P21", task: "Replace the filter", status: "Open", to: "Muse", revision: "a".repeat(24) };
  let tryAdd = 0;
  const sheets = {
    configured: true,
    async listOpen() { return [task]; },
    async add(op) {
      writes.push(op);
      if (++tryAdd === 1) throw Object.assign(new Error("unknown write"), { code: "SHEET_UNCONFIRMED" });
      return [task];
    },
    async update(op) {
      assert.equal(op.revision, task.revision);
      writes.push(op);
      return { ...task, status: op.status };
    },
  };
  const link = createCloudLink({
    relayUrl: "https://relay.example",
    homeToken: "test-home",
    board: { listTasks: () => [], listActivity: () => [] },
    notices: { listAll: () => [], listOpen: () => [] },
    manifest: {},
    makeSheetTasks: () => sheets,
    onError: error => notes.push(error.code),
    async fetchFn(url, { method, body }) {
      const route = new URL(url).pathname.split("/").at(-1);
      const result = await call(method, route, body && JSON.parse(body), "test-home");
      return new Response(JSON.stringify(result.body), { status: result.status });
    },
  });
  assert.equal(await link.tick(), true);

  const requestId = "2".repeat(32);
  await call("POST", "sheet", { requestId, action: "add", tasks: [task.task] });
  assert.equal(await link.tick(), true);
  assert.deepEqual(notes, ["SHEET_UNCONFIRMED"]);
  assert.equal((await call("POST", "sheetstatus", { requestId })).body.state, "queued");
  assert.equal(await link.tick(), true);
  const saved = (await call("POST", "sheetstatus", { requestId })).body.receipt;
  assert.equal(saved.success, true);
  assert.match(saved.message, /Saved 1 task/);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[0].source, "phone");
  assert.equal(writes[0].requestId, requestId);

  const listId = "3".repeat(32);
  await call("POST", "sheet", { requestId: listId, action: "list" });
  await link.tick();
  assert.deepEqual((await call("POST", "sheetstatus", { requestId: listId })).body.receipt.tasks, [task]);
  const update = { requestId: "4".repeat(32), action: "update", id: task.id, status: "Done", revision: task.revision };
  assert.equal((await call("POST", "sheet", { ...update, id: "Tasks!A1" })).status, 400);
  assert.equal((await call("POST", "sheet", update)).status, 200);
  await link.tick();
  assert.equal((await call("POST", "sheetstatus", update)).body.receipt.tasks[0].status, "Done");
  assert.equal(writes[2].source, "phone");
});
