#!/usr/bin/env node
"use strict";

// Runs AI-first OS v2 in a temporary profile directory with a mock runner for UI previews.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDaemon } = require("../lib/v2/daemon.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-preview-"));
const daemon = createDaemon({
  profileDir: dir,
  runner: async ({ stage, prompt }) => ({
    ok: true,
    output: JSON.stringify({
      stage,
      status: stage === "audit" ? "clean" : "ready",
      summary: `Preview ${stage} complete for: ${String(prompt).slice(0, 80)}`,
      findings: [],
    }),
  }),
});

daemon.start({ host: "127.0.0.1", port: Number(process.env.PORT || 4701) }).then(started => {
  process.stdout.write(`AI-first OS v2 preview at ${started.url}\n`);
});
