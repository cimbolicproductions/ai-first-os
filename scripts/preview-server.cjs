#!/usr/bin/env node
"use strict";

// Runs the desktop app in a throwaway folder on a fixed port, for trying the screens.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");
const { runInit } = require("../bin/aios.cjs");
const { profileFromIntro } = require("../lib/first-run.cjs");
const { saveManifest } = require("../lib/workspace.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-preview-"));
const server = createDesktopServer({
  workspaceRoot: dir,
  onSaveManifest: next => saveManifest(dir, next),
  runner: async () => ({ status: "Done", note: "Preview run: nothing was really done." }),
  async onIntroComplete({ selection, detected }) {
    return runInit({ workspaceRoot: dir, answers: profileFromIntro(selection, detected), detected });
  },
});
server.listen(Number(process.env.PORT || 4701), "127.0.0.1", () => {
  process.stdout.write(`Preview at http://127.0.0.1:${server.address().port}\n`);
});
