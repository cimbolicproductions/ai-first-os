"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { findHarness } = require("../lib/harness-registry.cjs");
const { routeTask } = require("../lib/roles.cjs");
const { defaultCliRunner } = require("../lib/os-runtime.cjs");

test("Antigravity's sign-in is checked by listing its models", () => {
  const { status } = findHarness("antigravity");
  assert.deepEqual(status.args, ["models"]);
  assert.equal(status.parse("Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)", 0), true);
  assert.equal(status.parse("Please sign in to continue: run agy and log in", 1), false);
  assert.equal(status.parse("network error", 1), null);
});

test("Antigravity codes in the one mode that refuses every command, so it can never buy anything", () => {
  const { run } = findHarness("antigravity");
  const write = run.args({ mode: "write", cwd: "C:/work" });
  assert.deepEqual(write.slice(write.indexOf("--mode"), write.indexOf("--mode") + 2), ["--mode", "accept-edits"]);
  for (const forbidden of ["auto", "--dangerously-skip-permissions"]) assert.equal(write.includes(forbidden), false);
  assert.deepEqual(run.args({ mode: "read", cwd: "C:/work" }).slice(2, 4), ["--mode", "plan"]);
  const manifest = { roles: { builder: "antigravity" }, priorities: { builder: ["antigravity", "opencode"] } };
  assert.equal(routeTask({ assigned: "antigravity", manifest, availability: { antigravity: true, opencode: true }, role: "builder" }).agent, "antigravity");
});

test("a coding run tells Antigravity first that commands are off; a reading run does not", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-agy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = { on() {}, end() {}, write() {} };
    setImmediate(() => { child.stdout.emit("data", "Wrote index.html.\nStill to run: npm install"); child.emit("close", 0); });
    return child;
  };
  const detect = () => [{ id: "antigravity", installed: true, signedIn: true, headless: true, workerPath: "C:/agy/agy.exe" }];
  const order = () => fs.readFileSync(path.join(dir, ".aios", "work-orders", "P1.md"), "utf8");
  await defaultCliRunner({ agent: "antigravity", prompt: "Build the page.", cwd: dir, task: { ID: "P1", Task: "Build the page" }, mode: "write", detect, spawnFn });
  assert.match(order(), /^In this run you can read and edit files in the project, but every shell command is refused/);
  assert.match(order(), /Still to run/);
  assert.match(order(), /Build the page\.$/);
  await defaultCliRunner({ agent: "antigravity", prompt: "Look it over.", cwd: dir, task: { ID: "P1", Task: "Look it over" }, mode: "read", detect, spawnFn });
  assert.equal(order(), "Look it over.");
});
