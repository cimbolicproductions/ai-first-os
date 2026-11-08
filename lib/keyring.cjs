"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Secret-hygiene regexes matching GitHub Secret Hygiene & Safe Publishing rules.
const SECRET_REGEX = /(sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]+|rk_live_[A-Za-z0-9]+|sb_secret_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bap]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.|-----BEGIN [A-Z ]*PRIVATE KEY)/;

const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash", "runs", "state"]);
const TEXT_EXTENSIONS = new Set([".md", ".json", ".yaml", ".yml", ".cjs", ".js", ".mjs", ".ts", ".ps1", ".sh", ".toml", ".txt"]);

function validateSecretName(name) {
  return typeof name === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(name);
}

/**
 * Checks whether a named credential exists in the current machine's OS keyring
 * or environment WITHOUT ever returning or logging the secret value.
 */
function checkSecretExists(secretName, { platform = process.platform, env = process.env, execProbe = spawnSync } = {}) {
  if (!validateSecretName(secretName)) {
    throw new Error(`Invalid secret name "${secretName}". Use UPPER_SNAKE_CASE names only, never raw values.`);
  }
  if (typeof env[secretName] === "string" && env[secretName].trim().length > 0) {
    return { present: true, backend: "env" };
  }
  if (platform === "win32") {
    const res = execProbe("cmdkey.exe", ["/list:" + secretName], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    if (res.status === 0 && /Target:/i.test(res.stdout || "")) {
      return { present: true, backend: "windows-credential-manager" };
    }
    return { present: false, backend: "windows-credential-manager" };
  }
  if (platform === "darwin") {
    const res = execProbe("security", ["find-generic-password", "-s", secretName], { encoding: "utf8", timeout: 3000 });
    return { present: res.status === 0, backend: "macos-keychain" };
  }
  const res = execProbe("secret-tool", ["lookup", "service", "agent-fleet", "key", secretName], { encoding: "utf8", timeout: 3000 });
  return { present: res.status === 0 && Boolean((res.stdout || "").trim()), backend: "linux-secret-service" };
}

/**
 * Scans a directory tree for accidentally committed secret values or .env files.
 * Never prints matched secret values; reports file + line number only.
 */
function scanDirectoryForSecrets(rootDir) {
  const findings = [];
  const root = path.resolve(rootDir);

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/^\.env(\..+)?$/i.test(entry.name) && entry.name !== ".env.example") {
        findings.push({ file: rel, line: 0, kind: "forbidden_env_file" });
        continue;
      }
      if (/\.(pem|key)$/i.test(entry.name) || /service-account.*\.json$/i.test(entry.name)) {
        findings.push({ file: rel, line: 0, kind: "forbidden_key_file" });
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (SECRET_REGEX.test(line)) {
          findings.push({ file: rel, line: idx + 1, kind: "secret_pattern_match" });
        }
      });
    }
  }

  if (fs.existsSync(root)) walk(root);
  return { clean: findings.length === 0, findings };
}

module.exports = {
  SECRET_REGEX,
  validateSecretName,
  checkSecretExists,
  scanDirectoryForSecrets,
};
