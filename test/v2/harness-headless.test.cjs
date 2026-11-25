"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { runHarness } = require("../../lib/v2/harnesses.cjs");
const { classifyProviderFailure } = require("../../lib/v2/quota.cjs");

function fakeProcess({ stdout = "", stderr = "", exitCode = 0 }) {
  const fixture = { args: [], input: "" };
  fixture.spawn = (_file, args) => {
    fixture.args = args;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.on("data", chunk => { fixture.input += chunk; });
    child.stdin.on("end", () => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", exitCode);
    });
    return child;
  };
  return fixture;
}

function readOptions(fixture, provider = "antigravity") {
  return {
    provider,
    prompt: "Clarify the owner's request. & Keep the prompt out of Windows command arguments.",
    cwd: os.tmpdir(),
    resultFile: path.join(os.tmpdir(), "unused-stage-result-" + randomUUID() + ".json"),
    mode: "read",
    detect: () => [{ id: provider, workerPath: "fixture.exe" }],
    spawnFn: fixture.spawn,
  };
}

test("Antigravity receives a read-only stage directly on stdin and reports structured terminal results", async () => {
  const step = { event: "step_update", step_update: { state: "DONE", step_type: "tool", tool_name: "read_file" } };
  const result = { status: "answer", answer: "Ready." };
  const terminal = { event: "result", result: { status: "SUCCESS", response: "AIOS-RESULT: " + JSON.stringify(result) } };
  const fixture = fakeProcess({ stdout: JSON.stringify(step) + "\n" + JSON.stringify(terminal) });
  const options = readOptions(fixture);
  const activity = [];
  const outcome = await runHarness({ ...options, onActivity: message => activity.push(message) });

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.structured, result);
  assert.deepEqual(activity, ["Reading a file"]);
  assert.ok(fixture.args.includes("plan"));
  assert.equal(fixture.args.includes("--dangerously-skip-permissions"), false);
  assert.deepEqual(fixture.args.slice(-4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
  assert.equal(fixture.args.some(arg => arg.includes(options.prompt)), false);
  const input = JSON.parse(fixture.input);
  assert.equal(input.event, "user");
  assert.ok(input.message.content.includes(options.prompt));
  assert.match(input.message.content, /return the AIOS-RESULT line/);
});

test("A zero exit cannot mask Antigravity's headless permission denial", async () => {
  const message = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot obtain';
  const fixture = fakeProcess({ stdout: "Diagnostic startup output\n".repeat(60), stderr: message });
  const outcome = await runHarness(readOptions(fixture));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.kind, "permission_blocked");
  assert.equal(outcome.structured, null);
  assert.equal(classifyProviderFailure("antigravity", "invalid model selection (--model unknown)").kind, "model_unsupported");
});

test("Missing expected output fails closed even on a clean exit", async () => {
  const fixture = fakeProcess({ stdout: "Done, probably.\n".repeat(100) });
  const outcome = await runHarness(readOptions(fixture, "opencode"));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.kind, "no_result");
  assert.equal(outcome.structured, null);
  assert.equal(classifyProviderFailure("opencode", "", { exitCode: 0 }).kind, "unknown");
});
