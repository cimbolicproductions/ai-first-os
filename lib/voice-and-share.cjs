"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { detectInstalledAgents } = require("./agent-auth.cjs");
const { buildSpawnPlan } = require("./harness-registry.cjs");

function findIde(id, workspaceRoot) {
  const found = detectInstalledAgents({ workspaceRoot }).find(a => a.id === id);
  return found?.idePath || null;
}

/**
 * Native Voice-to-Text & 1-Keystroke "Share To..." Engine for AI-first OS.
 * - Captures voice using native OS speech recognition (Windows System.Speech,
 *   macOS dictation/say helper, or custom command) with zero clicking.
 * - Shares any text, clipboard content, file, or Task Board row directly to:
 *   Antigravity (`agy`), Claude Code (`claude`), Codex (`codex`), Gemini (`gemini`),
 *   or the shared Task Board via the Router.
 */

function readSystemClipboard({ platform = process.platform, execFn = spawnSync } = {}) {
  try {
    if (platform === "win32") {
      const res = execFn("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"], {
        encoding: "utf8",
        timeout: 4000,
      });
      return (res.stdout || "").trim();
    }
    if (platform === "darwin") {
      const res = execFn("pbpaste", [], { encoding: "utf8", timeout: 4000 });
      return (res.stdout || "").trim();
    }
    const res = execFn("wl-paste", ["--no-newline"], { encoding: "utf8", timeout: 4000 });
    return (res.stdout || "").trim();
  } catch {
    return "";
  }
}

function captureVoiceNative({
  timeoutSeconds = 8,
  platform = process.platform,
  execFn = spawnSync,
  mockTranscript = null,
} = {}) {
  if (typeof mockTranscript === "string") {
    return { ok: true, transcript: mockTranscript.trim(), source: "mock" };
  }

  if (platform === "win32") {
    const psScript = [
      "Add-Type -AssemblyName System.Speech;",
      "$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine;",
      "$rec.SetInputToDefaultAudioDevice();",
      "$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar));",
      `$res = $rec.Recognize([TimeSpan]::FromSeconds(${Number(timeoutSeconds) || 8}));`,
      "if ($res) { Write-Output $res.Text }",
    ].join(" ");

    const res = execFn("powershell.exe", ["-NoProfile", "-Command", psScript], {
      encoding: "utf8",
      timeout: (Number(timeoutSeconds) + 4) * 1000,
    });
    if (res.error) {
      return { ok: false, transcript: "", error: res.error.message };
    }
    const text = (res.stdout || "").trim();
    return { ok: Boolean(text), transcript: text, source: "windows-system-speech" };
  }

  return {
    ok: false,
    transcript: "",
    error: "Use browser Web Speech mic in `aios desktop` or set AIOS_VOICE_CMD for CLI mic capture.",
  };
}

function saveVoiceDumpToInbox({ vaultPath, transcript, routerName = "Router", board = null, autoQueueTo = null }) {
  const clean = String(transcript || "").trim();
  if (!clean) {
    throw Object.assign(new Error("Empty voice transcript"), { code: "EMPTY_TRANSCRIPT" });
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const inboxDir = path.join(vaultPath, "00_Inbox", "Brain_Dumps");
  fs.mkdirSync(inboxDir, { recursive: true });

  const filePath = path.join(inboxDir, `voice-dump-${stamp}.md`);
  fs.writeFileSync(
    filePath,
    [
      `# Voice Capture - ${dateStr}`,
      ``,
      `Captured via AI-first OS Native Voice-to-Text.`,
      `Router: ${routerName}`,
      ``,
      `## Transcript`,
      clean,
      ``,
    ].join("\n"),
    "utf8"
  );

  let boardRow = null;
  if (board && autoQueueTo) {
    boardRow = board.addTask({
      task: clean.slice(0, 140),
      to: autoQueueTo,
      from: routerName,
      specFile: filePath,
      note: `Created from native voice dump (${path.basename(filePath)}).`,
    });
  }

  return { filePath, boardRow };
}

/**
 * Shares payload (text, clipboard, or task row) directly to Antigravity, Claude Code,
 * Codex, Gemini, or queues it onto the shared Task Board.
 */
function shareToTarget({
  target,
  content,
  workspaceRoot = process.cwd(),
  vaultPath,
  board = null,
  routerName = "Router",
  spawnFn = spawn,
  dryRun = false,
} = {}) {
  const payload = String(content || "").trim() || readSystemClipboard();
  if (!payload) {
    throw Object.assign(new Error("Nothing to share (provide content or copy text to clipboard)"), {
      code: "EMPTY_SHARE_PAYLOAD",
    });
  }

  const normalizedTarget = String(target || "board").toLowerCase();
  const handoffDir = path.join(vaultPath || path.join(workspaceRoot, "ContextVault"), "06_AI_Context", "Handoffs");
  fs.mkdirSync(handoffDir, { recursive: true });
  const handoffFile = path.join(handoffDir, `share-${normalizedTarget}-${Date.now()}.md`);
  fs.writeFileSync(
    handoffFile,
    `# Shared Context -> ${normalizedTarget.toUpperCase()}\n\n${payload}\n`,
    "utf8"
  );

  let boardRow = null;
  if (board) {
    const assignee = normalizedTarget === "board" ? "claude" : normalizedTarget;
    boardRow = board.addTask({
      task: payload.split(/\r?\n/)[0].slice(0, 120),
      to: assignee,
      from: routerName,
      specFile: handoffFile,
      note: `Shared via 1-keystroke Share -> ${normalizedTarget}`,
    });
  }

  // Command-line agents pick the shared text up from the board row. Only desktop
  // apps are opened here, and only ever on file paths, never on the text itself.
  const ideTargets = {
    agy: () => findIde("antigravity", workspaceRoot),
    antigravity: () => findIde("antigravity", workspaceRoot),
    cursor: () => findIde("cursor", workspaceRoot),
  };

  let launched = false;
  if (ideTargets[normalizedTarget] && !dryRun) {
    try {
      const ide = ideTargets[normalizedTarget]();
      if (ide) {
        const plan = buildSpawnPlan(ide, [workspaceRoot, handoffFile]);
        const child = spawnFn(plan.file, plan.args, {
          cwd: workspaceRoot,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          ...plan.options,
        });
        if (child && typeof child.on === "function") child.on("error", () => {});
        if (child && typeof child.unref === "function") child.unref();
        launched = true;
      }
    } catch {
      launched = false;
    }
  }

  return {
    ok: true,
    target: normalizedTarget,
    handoffFile,
    boardRow,
    launched,
  };
}

module.exports = {
  readSystemClipboard,
  captureVoiceNative,
  saveVoiceDumpToInbox,
  shareToTarget,
};
