"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Public Repository Privacy & Secret Leak Guard.
 *
 * Scans tracked files in a repository to ensure zero personal data (local user
 * paths, Tailscale CGNAT IPs, real Google Sheet IDs, personal Supabase refs,
 * or API keys) ever enter the public repository. Uses strictly generic patterns.
 */

const TEXT_EXTS = new Set([
  ".cjs", ".js", ".mjs", ".ts", ".tsx", ".json", ".yaml", ".yml",
  ".md", ".html", ".css", ".sh", ".ps1", ".cmd", ".txt", ".conf", ".webmanifest",
]);

const GENERIC_USERNAMES = new Set([
  "user", "owner", "alice", "bob", "example", "test", "runner", "admin",
  "developer", "dev", "me", "you", "name", "username", "someone",
]);

const CHECKS = Object.freeze([
  {
    id: "secret-token",
    pattern: /(sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}|sb_secret_[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bap]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
    message: "Looks like a hardcoded API key or private key",
  },
  {
    id: "tailscale-ip",
    pattern: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    message: "Hardcoded Tailscale CGNAT IP address",
  },
  {
    id: "personal-drive-path",
    pattern: /\b[D-Z]:(?:\\{1,2}|\/)(?:GitHub|Documents|Projects|Users)(?:\\{1,2}|\/)[^\s"'`<>]+/gi,
    message: "Hardcoded local secondary-drive path",
  },
  {
    id: "windows-user-path",
    pattern: /\bC:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)([A-Za-z0-9._-]{2,32})(?:\\{1,2}|\/)/gi,
    validate(match) {
      const user = String(match[1] || "").toLowerCase();
      return !GENERIC_USERNAMES.has(user);
    },
    message: "Hardcoded personal Windows user directory",
  },
  {
    id: "google-sheet-id",
    pattern: /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{28,})/g,
    validate(match) {
      const id = String(match[1] || "");
      return !/^(?:example|test|fake|sample|placeholder|0+)/i.test(id);
    },
    message: "Hardcoded Google Spreadsheet URL/ID",
  },
  {
    id: "supabase-project-ref",
    pattern: /https:\/\/([a-z]{16,24})\.supabase\.co\b/g,
    validate(match) {
      const ref = String(match[1] || "");
      return !/^(?:example|test|fake|demo|yourproject|placeholder)/i.test(ref);
    },
    message: "Hardcoded Supabase project URL",
  },
]);

function scanText(text, relPath = "<memory>") {
  const findings = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Allow explicit test fixtures marked with leak-guard-ignore on the same line.
    if (line.includes("leak-guard-ignore")) continue;
    for (const check of CHECKS) {
      check.pattern.lastIndex = 0;
      let m;
      while ((m = check.pattern.exec(line)) !== null) {
        if (check.validate && !check.validate(m)) continue;
        findings.push({
          file: relPath,
          line: i + 1,
          rule: check.id,
          message: check.message,
          snippet: m[0].slice(0, 60),
        });
      }
    }
  }
  return findings;
}

function listTrackedFiles(repoRoot, { includeUntracked = true } = {}) {
  const args = includeUntracked ? ["ls-files", "-z", "--cached", "--others", "--exclude-standard"] : ["ls-files", "-z"];
  const res = spawnSync(process.platform === "win32" ? "git.exe" : "git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.stderr || res.error?.message}`);
  }
  return [...new Set(res.stdout.split("\0").filter(Boolean))];
}

function scanRepository(repoRoot, { files = null } = {}) {
  const root = path.resolve(repoRoot);
  const targets = files || listTrackedFiles(root);
  const findings = [];
  for (const rel of targets) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const content = fs.readFileSync(full, "utf8");
    findings.push(...scanText(content, rel));
  }
  return { clean: findings.length === 0, scanned: targets.length, findings };
}

module.exports = { CHECKS, scanText, scanRepository, listTrackedFiles };
