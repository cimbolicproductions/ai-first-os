#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Builds one self-contained installer per platform: double-click, and it gets its
 * own runtime if the machine has none, unpacks the app, adds a shortcut, and opens.
 * The runtime download is pinned to a checksum captured when the installer is built.
 */

const ROOT = path.join(__dirname, "..");
const INCLUDE = ["bin", "lib", "adapters", "phone", "os", "product.json", "package.json", "LICENSE", "README.md"];
const NODE_MAJOR = 22;

function collectFiles() {
  const files = {};
  const walk = rel => {
    const full = path.join(ROOT, rel);
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full)) walk(path.posix.join(rel, name));
    } else {
      files[rel] = fs.readFileSync(full).toString("base64");
    }
  };
  INCLUDE.forEach(walk);
  return files;
}

const STAGE2 = String.raw`"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const installer = process.argv[2];
const line = fs.readFileSync(installer, "latin1").split(/\r?\n/).find(l => l.startsWith("AIOS_PAYLOAD="));
const files = JSON.parse(Buffer.from(line.slice("AIOS_PAYLOAD=".length), "base64").toString("utf8"));

const home = process.env.AIOS_HOME || os.homedir();
const installRoot = process.env.AIOS_INSTALL_ROOT || path.join(home, ".ai-first-os");
const appDir = path.join(installRoot, "app");
const next = path.join(installRoot, "app.next");
const workspace = process.env.AIOS_WORKSPACE || path.join(home, "AI-first OS");

fs.rmSync(next, { recursive: true, force: true });
for (const [rel, data] of Object.entries(files)) {
  const target = path.join(next, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(data, "base64"));
}
fs.rmSync(appDir, { recursive: true, force: true });
fs.renameSync(next, appDir);
fs.mkdirSync(workspace, { recursive: true });

const cli = path.join(appDir, "bin", "aios.cjs");
const desktopDir = path.join(home, "Desktop");

if (!process.env.AIOS_NO_SHORTCUT) {
  if (process.platform === "win32") {
    const opener = path.join(installRoot, "open.vbs");
    const q = v => '""' + v + '""';
    fs.writeFileSync(opener, 'CreateObject("WScript.Shell").Run "' + [process.execPath, cli, "desktop", "--dir", workspace].map(q).join(" ") + '", 0, False\r\n');
    const script = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\AI-first OS.lnk');$s.TargetPath='wscript.exe';$s.Arguments='\"" + opener + "\"';$s.Save()";
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  } else if (process.platform === "darwin") {
    fs.mkdirSync(desktopDir, { recursive: true });
    const shortcut = path.join(desktopDir, "AI-first OS.command");
    fs.writeFileSync(shortcut, '#!/bin/sh\nexec "' + process.execPath + '" "' + cli + '" desktop --dir "' + workspace + '"\n', { mode: 0o755 });
  } else {
    const apps = path.join(home, ".local", "share", "applications");
    fs.mkdirSync(apps, { recursive: true });
    fs.writeFileSync(path.join(apps, "ai-first-os.desktop"), '[Desktop Entry]\nType=Application\nName=AI-first OS\nExec="' + process.execPath + '" "' + cli + '" desktop --dir "' + workspace + '"\nTerminal=false\n');
  }
}

console.log("AI-first OS is installed.");
if (!process.env.AIOS_NO_LAUNCH) {
  const child = spawn(process.execPath, [cli, "desktop", "--dir", workspace], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
`;

function renderWindows({ version, sums, stage2, payload }) {
  const ps = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = if ($env:AIOS_INSTALL_ROOT) { $env:AIOS_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'AI-first OS' }
New-Item -ItemType Directory -Force -Path $root | Out-Null
$nodeExe = $null
if (-not $env:AIOS_FORCE_DOWNLOAD) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) {
    $major = [int]((& $found.Source -p 'process.versions.node').Split('.')[0])
    if ($major -ge ${NODE_MAJOR}) { $nodeExe = $found.Source }
  }
}
if (-not $nodeExe) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $hashes = @{ x64 = '${sums["win-x64"]}'; arm64 = '${sums["win-arm64"]}' }
  $name = 'node-v${version}-win-' + $arch
  $base = if ($env:AIOS_NODE_MIRROR) { $env:AIOS_NODE_MIRROR } else { 'https://nodejs.org/dist/v${version}' }
  $zip = Join-Path $root 'runtime.zip'
  Invoke-WebRequest -UseBasicParsing -Uri ($base + '/' + $name + '.zip') -OutFile $zip
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower() -ne $hashes[$arch]) {
    Remove-Item -Force $zip
    throw 'The runtime download did not match its checksum. Nothing was installed.'
  }
  $runtime = Join-Path $root 'runtime'
  if (Test-Path $runtime) { Remove-Item -Recurse -Force $runtime }
  Expand-Archive -LiteralPath $zip -DestinationPath $runtime
  Remove-Item -Force $zip
  $nodeExe = Join-Path (Join-Path $runtime $name) 'node.exe'
}
$line = Select-String -LiteralPath $env:AIOS_SELF -Pattern '^AIOS_STAGE2=' | Select-Object -First 1
$stage = Join-Path $root 'stage2.cjs'
[IO.File]::WriteAllBytes($stage, [Convert]::FromBase64String($line.Line.Substring(12)))
& $nodeExe $stage $env:AIOS_SELF
if ($LASTEXITCODE -ne 0) { throw 'Setup could not finish.' }
Remove-Item -Force $stage
`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  // cmd.exe caps a line at 8191 characters, so PowerShell reads its script from this file.
  return [
    "@echo off",
    "setlocal",
    'set "AIOS_SELF=%~f0"',
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$l=Select-String -LiteralPath $env:AIOS_SELF -Pattern '^AIOS_SCRIPT=' | Select-Object -First 1; Invoke-Expression ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($l.Line.Substring(12))))"`,
    "if errorlevel 1 (",
    "  echo.",
    "  echo AI-first OS could not finish setting up.",
    "  if not defined AIOS_NO_LAUNCH pause",
    "  exit /b 1",
    ")",
    "exit /b 0",
    `AIOS_SCRIPT=${encoded}`,
    `AIOS_STAGE2=${stage2}`,
    `AIOS_PAYLOAD=${payload}`,
    "",
  ].join("\r\n");
}

function renderUnix({ platform, version, sums, stage2, payload }) {
  const tag = platform === "darwin" ? "darwin" : "linux";
  return `#!/bin/sh
set -e
SELF="$0"
ROOT="\${AIOS_INSTALL_ROOT:-$HOME/.ai-first-os}"
mkdir -p "$ROOT"
NODE=""
if [ -z "$AIOS_FORCE_DOWNLOAD" ] && command -v node >/dev/null 2>&1; then
  if [ "$(node -p 'process.versions.node.split(".")[0]')" -ge ${NODE_MAJOR} ]; then NODE="$(command -v node)"; fi
fi
if [ -z "$NODE" ]; then
  case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64; WANT="${sums[`${tag}-arm64`]}" ;;
    *) ARCH=x64; WANT="${sums[`${tag}-x64`]}" ;;
  esac
  NAME="node-v${version}-${tag}-$ARCH"
  BASE="\${AIOS_NODE_MIRROR:-https://nodejs.org/dist/v${version}}"
  curl -fsSL "$BASE/$NAME.tar.gz" -o "$ROOT/runtime.tar.gz"
  if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$ROOT/runtime.tar.gz" | cut -d' ' -f1)"; else GOT="$(shasum -a 256 "$ROOT/runtime.tar.gz" | cut -d' ' -f1)"; fi
  if [ "$GOT" != "$WANT" ]; then rm -f "$ROOT/runtime.tar.gz"; echo "The runtime download did not match its checksum. Nothing was installed." >&2; exit 1; fi
  rm -rf "$ROOT/runtime"; mkdir -p "$ROOT/runtime"
  tar -xzf "$ROOT/runtime.tar.gz" -C "$ROOT/runtime"
  rm -f "$ROOT/runtime.tar.gz"
  NODE="$ROOT/runtime/$NAME/bin/node"
fi
grep '^AIOS_STAGE2=' "$SELF" | cut -d= -f2- | base64 -d > "$ROOT/stage2.cjs"
"$NODE" "$ROOT/stage2.cjs" "$SELF"
rm -f "$ROOT/stage2.cjs"
exit 0
AIOS_STAGE2=${stage2}
AIOS_PAYLOAD=${payload}
`;
}

function parseSums(text) {
  const sums = {};
  let version = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+node-v(\d+\.\d+\.\d+)-(win-x64|win-arm64)\.zip$/) || line.match(/^([0-9a-f]{64})\s+node-v(\d+\.\d+\.\d+)-((?:darwin|linux)-(?:x64|arm64))\.tar\.gz$/);
    if (m) {
      sums[m[3]] = m[1];
      version = m[2];
    }
  }
  if (!version) throw new Error("Could not read the runtime checksums.");
  return { version, sums };
}

function buildInstallers({ outDir, version, sums }) {
  fs.mkdirSync(outDir, { recursive: true });
  const stage2 = Buffer.from(STAGE2, "utf8").toString("base64");
  const payload = Buffer.from(JSON.stringify(collectFiles()), "utf8").toString("base64");
  const outputs = {
    win32: path.join(outDir, "AI-first-OS-Setup.cmd"),
    darwin: path.join(outDir, "AI-first-OS-Setup.command"),
    linux: path.join(outDir, "ai-first-os-setup.sh"),
  };
  fs.writeFileSync(outputs.win32, renderWindows({ version, sums, stage2, payload }), "ascii");
  fs.writeFileSync(outputs.darwin, renderUnix({ platform: "darwin", version, sums, stage2, payload }), { mode: 0o755 });
  fs.writeFileSync(outputs.linux, renderUnix({ platform: "linux", version, sums, stage2, payload }), { mode: 0o755 });
  return outputs;
}

if (require.main === module) {
  (async () => {
    const res = await fetch(`https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt`);
    if (!res.ok) throw new Error(`Could not fetch runtime checksums (${res.status}).`);
    const { version, sums } = parseSums(await res.text());
    const outputs = buildInstallers({ outDir: path.join(ROOT, "dist"), version, sums });
    process.stdout.write(`Built for Node ${version}:\n${Object.values(outputs).join("\n")}\n`);
  })().catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildInstallers, parseSums, collectFiles };
