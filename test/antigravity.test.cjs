"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { findHarness } = require("../lib/harness-registry.cjs");
const { routeTask } = require("../lib/roles.cjs");

test("Antigravity's sign-in is checked by listing its models", () => {
  const { status } = findHarness("antigravity");
  assert.deepEqual(status.args, ["models"]);
  assert.equal(status.parse("Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)", 0), true);
  assert.equal(status.parse("Please sign in to continue: run agy and log in", 1), false);
  assert.equal(status.parse("network error", 1), null);
});

test("Antigravity is never handed building work, even as the owner's first coding pick", () => {
  const manifest = { roles: { builder: "antigravity", researcher: "antigravity" }, priorities: { builder: ["antigravity", "opencode"] } };
  assert.equal(routeTask({ assigned: "antigravity", manifest, availability: { antigravity: true, opencode: true }, role: "builder" }).agent, "opencode");
  assert.equal(routeTask({ assigned: "antigravity", manifest, availability: { antigravity: true }, role: "builder" }).agent, null);
  // Research and review still go to it.
  assert.equal(routeTask({ assigned: "antigravity", manifest, availability: { antigravity: true }, role: "researcher" }).agent, "antigravity");
  assert.equal(routeTask({ assigned: "antigravity", manifest, availability: { antigravity: true }, role: "auditor" }).agent, "antigravity");
});
