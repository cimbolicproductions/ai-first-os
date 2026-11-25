"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { scanText } = require("./leak-guard.cjs");

/**
 * Terminal Agent-to-Agent Bus & Per-Task Artifact Workspace.
 *
 * Each task owns one self-contained run directory under ~/.aios/runs/<taskId>/
 * (never polluting target repositories):
 *   - brief.json         (locked owner requirements + acceptance criteria)
 *   - plan.md            (detailed implementation spec from Planner)
 *   - bus.jsonl          (append-only agent-to-agent messages)
 *   - diff.patch         (deterministic git diff from isolated worktree)
 *   - test.log           (deterministic verification output)
 *   - audit.json         (structured cross-model audit verdict + findings)
 *   - delivery.json      (Total Output summary card for Desktop, Phone & Muse)
 *   - stage-result.json  (active stage output contract)
 *   - refs/              (safe read-only copies of cross-repo reference files)
 */

const MAX_REF_FILE_BYTES = 64 * 1024;
const MAX_REF_FILES = 12;

function safeTaskDirName(taskId) {
  const clean = String(taskId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!clean) throw new Error("Invalid task ID for run directory.");
  return clean;
}

function createRunSpace({ runsDir, taskId }) {
  const dir = path.join(path.resolve(runsDir), safeTaskDirName(taskId));
  fs.mkdirSync(dir, { recursive: true });

  const file = name => path.join(dir, name);

  function writeJson(name, value) {
    fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + "\n", "utf8");
    return file(name);
  }

  function readJson(name, fallback = null) {
    const p = file(name);
    if (!fs.existsSync(p)) return fallback;
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
  }

  function writeText(name, content) {
    fs.writeFileSync(file(name), String(content ?? ""), "utf8");
    return file(name);
  }

  function readText(name, fallback = "") {
    const p = file(name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : fallback;
  }

  function clearStageResult() {
    fs.rmSync(file("stage-result.json"), { force: true });
    return file("stage-result.json");
  }

  function appendBus(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(file("bus.jsonl"), line + "\n", "utf8");
    return entry;
  }

  function readBus() {
    const raw = readText("bus.jsonl");
    if (!raw.trim()) return [];
    return raw.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  /**
   * Copies small read-only reference files from outside the target repo into
   * <runDir>/refs/ so sandboxed CLIs (like OpenCode) never fail with
   * external_directory permission denials. Skips binary files and secrets.
   */
  function stageReferenceFiles(filePaths = []) {
    const staged = [];
    const refsDir = path.join(dir, "refs");
    for (const src of (filePaths || []).slice(0, MAX_REF_FILES)) {
      if (typeof src !== "string" || !src.trim()) continue;
      const abs = path.resolve(src);
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_REF_FILE_BYTES) continue;
        const content = fs.readFileSync(abs, "utf8");
        if (content.includes("\0")) continue;
        // Refuse staging any file that contains raw API secrets.
        const leaks = scanText(content, abs).filter(f => f.rule === "secret-token");
        if (leaks.length) continue;
        fs.mkdirSync(refsDir, { recursive: true });
        const destName = `${staged.length + 1}-${path.basename(abs).replace(/[^A-Za-z0-9._-]/g, "_")}`;
        const dest = path.join(refsDir, destName);
        fs.writeFileSync(dest, content, "utf8");
        staged.push({ source: abs, stagedPath: dest, name: destName });
      } catch {
        // Ignore missing/unreadable reference files.
      }
    }
    return staged;
  }

  return {
    dir,
    file,
    resultFile: file("stage-result.json"),
    writeJson,
    readJson,
    writeText,
    readText,
    clearStageResult,
    appendBus,
    readBus,
    stageReferenceFiles,
  };
}

/**
 * Writes a clean, non-destructive delivery summary into the user's real Obsidian
 * vault (when vaultPath is configured in ~/.aios/profile.json).
 */
function syncDeliveryToVault({ profile, task, delivery }) {
  if (!profile?.vaultPath) return null;
  const vaultRoot = path.resolve(profile.vaultPath);
  if (!fs.existsSync(vaultRoot)) return null;
  const projectSlug = String(task.projectName || "General").replace(/[^A-Za-z0-9 _.-]/g, " ").trim() || "General";
  const outDir = path.join(vaultRoot, "AI-first OS", "Projects");
  const outFile = path.join(outDir, `${projectSlug}.md`);
  fs.mkdirSync(outDir, { recursive: true });

  const day = new Date().toISOString().slice(0, 10);
  const entry = [
    `## ${day} · ${task.id} — ${delivery.title || task.title}`,
    `- **Stakes:** ${task.stakes} | **Status:** ${delivery.merged ? "Merged" : delivery.awaitingShip ? "Ready to merge" : "Completed"}`,
    `- **Agents:** ${delivery.agentsUsed?.join(" -> ") || "n/a"}`,
    `- **Audit:** ${delivery.auditVerdict || "n/a"} (${delivery.auditRounds || 0} round${delivery.auditRounds === 1 ? "" : "s"})`,
    ...(delivery.branch ? [`- **Branch:** \`${delivery.branch}\`${delivery.commitHash ? ` (\`${delivery.commitHash.slice(0, 8)}\`)` : ""}`] : []),
    ...(delivery.filesChanged?.length ? [`- **Files:** ${delivery.filesChanged.slice(0, 15).map(f => `\`${f}\``).join(", ")}`] : []),
    ``,
    delivery.summary || "",
    ``,
  ].join("\n");

  const existing = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : `# ${projectSlug}\n\n`;
  fs.writeFileSync(outFile, existing.trimEnd() + "\n\n" + entry, "utf8");
  return outFile;
}

module.exports = { createRunSpace, syncDeliveryToVault };
