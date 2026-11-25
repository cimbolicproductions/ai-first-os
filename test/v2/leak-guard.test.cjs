"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { scanText, scanRepository } = require("../../lib/v2/leak-guard.cjs");

test("leak-guard catches Tailscale IPs, personal drive paths, personal home dirs, Sheet IDs, and secrets", () => {
  const sample = [
    "const ip = '100.64.0.42';", // leak-guard-ignore
    "const repo = 'D:\\\\GitHub\\\\my-business-app';", // leak-guard-ignore
    "const home = 'C:\\\\Users\\\\johnsmith\\\\Projects';", // leak-guard-ignore
    "const sheet = 'https://docs.google.com/spreadsheets/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789/edit';", // leak-guard-ignore
    "const sb = 'https://abcdefghijklmnopqrst.supabase.co';", // leak-guard-ignore
    "const key = 'sk_live_1234567890abcdef';", // leak-guard-ignore
  ].join("\n");
  const findings = scanText(sample, "sample.cjs");
  const rules = new Set(findings.map(f => f.rule));
  assert.ok(rules.has("tailscale-ip"));
  assert.ok(rules.has("personal-drive-path"));
  assert.ok(rules.has("windows-user-path"));
  assert.ok(rules.has("google-sheet-id"));
  assert.ok(rules.has("supabase-project-ref"));
  assert.ok(rules.has("secret-token"));
});

test("leak-guard allows generic placeholder usernames and example URLs", () => {
  const safe = [
    "const home = 'C:\\\\Users\\\\User\\\\Projects';",
    "const ex = 'C:\\\\Users\\\\Alice\\\\vault';",
    "const sb = 'https://exampleprojectref.supabase.co';",
    "const sheet = 'https://docs.google.com/spreadsheets/d/EXAMPLE_SHEET_ID_000000000000000000/edit';",
  ].join("\n");
  assert.deepEqual(scanText(safe, "safe.cjs"), []);
});

test("public repository contains zero personal data leaks across tracked v2 files", () => {
  const repoRoot = path.join(__dirname, "..", "..");
  const result = scanRepository(repoRoot);
  assert.equal(result.clean, true, `Unexpected leaks found:\n${JSON.stringify(result.findings, null, 2)}`);
});
