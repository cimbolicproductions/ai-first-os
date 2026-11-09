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

const WINDOWS_CRED_TYPE = `
using System;
using System.Runtime.InteropServices;
public static class AiosCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL c, int flags);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32")] public static extern void CredFree(IntPtr c);
  public static void Write(string target, byte[] blob) {
    var p = Marshal.AllocHGlobal(blob.Length);
    Marshal.Copy(blob, 0, p, blob.Length);
    var c = new CREDENTIAL { Type = 1, TargetName = target, CredentialBlobSize = blob.Length, CredentialBlob = p, Persist = 2, UserName = "ai-first-os" };
    var ok = CredWriteW(ref c, 0);
    Marshal.FreeHGlobal(p);
    if (!ok) throw new Exception("write failed");
  }
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    var blob = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, blob, 0, blob.Length);
    CredFree(p);
    return blob;
  }
}`;

function runWindowsCred(script, input, execProbe) {
  const full = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOWS_CRED_TYPE}\n'@; ${script}`;
  return execProbe(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(full, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 20000, input }
  );
}

function assertSecretName(name) {
  if (!validateSecretName(name)) {
    throw new Error(`Invalid secret name "${name}". Use UPPER_SNAKE_CASE names only, never raw values.`);
  }
}

/** Saves a secret in the OS keyring. The value only ever travels over stdin. */
function storeSecret(name, value, { platform = process.platform, execProbe = spawnSync } = {}) {
  assertSecretName(name);
  const fail = detail => Object.assign(new Error(`Could not save ${name} to the keyring.${detail ? " " + detail : ""}`), { code: "KEYRING_WRITE_FAILED" });
  let res;
  if (platform === "win32") {
    res = runWindowsCred(
      `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [AiosCred]::Write('${name}',$b)`,
      Buffer.from(String(value), "utf8").toString("base64"),
      execProbe
    );
  } else if (platform === "darwin") {
    const escaped = String(value).replace(/(["\\])/g, "\\$1");
    res = execProbe("security", ["-i"], {
      encoding: "utf8",
      timeout: 10000,
      input: `add-generic-password -U -a ai-first-os -s ${name} -w "${escaped}"\n`,
    });
  } else {
    res = execProbe("secret-tool", ["store", `--label=${name}`, "service", "agent-fleet", "key", name], {
      encoding: "utf8",
      timeout: 10000,
      input: String(value),
    });
  }
  if (res.error || res.status !== 0) throw fail(platform === "linux" && res.error ? "Install secret-tool." : "");
  return { stored: true };
}

/** Returns the value, or null when it is not there. Never logs it. */
function readSecret(name, { platform = process.platform, env = process.env, execProbe = spawnSync } = {}) {
  assertSecretName(name);
  if (typeof env[name] === "string" && env[name].trim()) return env[name].trim();
  let res;
  if (platform === "win32") {
    res = runWindowsCred(
      `$b=[AiosCred]::Read('${name}'); if($b){[Console]::Out.Write([Convert]::ToBase64String($b))}`,
      "",
      execProbe
    );
    if (res.status !== 0 || !(res.stdout || "").trim()) return null;
    return Buffer.from(res.stdout.trim(), "base64").toString("utf8");
  }
  if (platform === "darwin") {
    res = execProbe("security", ["find-generic-password", "-a", "ai-first-os", "-s", name, "-w"], { encoding: "utf8", timeout: 5000 });
  } else {
    res = execProbe("secret-tool", ["lookup", "service", "agent-fleet", "key", name], { encoding: "utf8", timeout: 5000 });
  }
  if (res.status !== 0) return null;
  return (res.stdout || "").replace(/\r?\n$/, "") || null;
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
  storeSecret,
  readSecret,
  scanDirectoryForSecrets,
};
