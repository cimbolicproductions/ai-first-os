"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const SERVICE_NAME = "AI-first OS";
const SERVICE_ID = "ai-first-os";
const LAUNCH_LABEL = "com.ai-first-os.watch";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Starts at sign-in rather than at power-on, because agents use the person's own
 * credentials, which do not exist before they sign in. No administrator rights.
 */
function planAutostart({ nodePath = process.execPath, cliPath, workspaceRoot, homeDir = os.homedir(), platform = process.platform }) {
  const args = [cliPath, "keep-alive", "--dir", workspaceRoot];
  if (platform === "win32") {
    const stateDir = path.join(homeDir, ".ai-first-os");
    const launcher = path.join(stateDir, "start-hidden.vbs");
    const line = [nodePath, ...args].map(a => `""${a}""`).join(" ");
    return {
      platform,
      files: [{ path: launcher, content: `CreateObject("WScript.Shell").Run "${line}", 0, False\r\n` }],
      install: [["reg.exe", ["add", RUN_KEY, "/v", SERVICE_NAME, "/t", "REG_SZ", "/d", `wscript.exe "${launcher}"`, "/f"]]],
      uninstall: [["reg.exe", ["delete", RUN_KEY, "/v", SERVICE_NAME, "/f"]]],
      check: ["reg.exe", ["query", RUN_KEY, "/v", SERVICE_NAME]],
    };
  }
  if (platform === "darwin") {
    const plist = path.join(homeDir, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
    const programArgs = [nodePath, ...args].map(a => `    <string>${xmlEscape(a)}</string>`).join("\n");
    return {
      platform,
      files: [
        {
          path: plist,
          content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`,
        },
      ],
      install: [["launchctl", ["load", "-w", plist]]],
      uninstall: [["launchctl", ["unload", "-w", plist]]],
      check: ["launchctl", ["list", LAUNCH_LABEL]],
    };
  }
  const unit = path.join(homeDir, ".config", "systemd", "user", `${SERVICE_ID}.service`);
  const quoted = [nodePath, ...args].map(a => `"${a}"`).join(" ");
  return {
    platform,
    files: [
      {
        path: unit,
        content: `[Unit]\nDescription=${SERVICE_NAME}\n\n[Service]\nExecStart=${quoted}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
      },
    ],
    install: [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", SERVICE_ID]],
    ],
    uninstall: [["systemctl", ["--user", "disable", "--now", SERVICE_ID]]],
    check: ["systemctl", ["--user", "is-enabled", SERVICE_ID]],
  };
}

function runSteps(steps, execFn) {
  for (const [file, args] of steps) {
    const res = execFn(file, args, { encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (res.error || res.status !== 0) {
      return { ok: false, step: file, detail: (res.stderr || res.error?.message || "").trim().slice(0, 300) };
    }
  }
  return { ok: true };
}

function installAutostart(options, { execFn = spawnSync } = {}) {
  const plan = planAutostart(options);
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content, "utf8");
  }
  return { ...runSteps(plan.install, execFn), platform: plan.platform };
}

function removeAutostart(options, { execFn = spawnSync } = {}) {
  const plan = planAutostart(options);
  const result = runSteps(plan.uninstall, execFn);
  for (const file of plan.files) fs.rmSync(file.path, { force: true });
  return { ...result, platform: plan.platform };
}

function isAutostartInstalled(options, { execFn = spawnSync } = {}) {
  const plan = planAutostart(options);
  const res = execFn(plan.check[0], plan.check[1], { encoding: "utf8", windowsHide: true, timeout: 8000 });
  return res.status === 0;
}

/** Restarts the watcher if it dies, backing off so a crash cannot spin the CPU. */
function keepAlive({ nodePath = process.execPath, cliPath, workspaceRoot, spawnFn = spawn, maxDelayMs = 60000 }) {
  let delay = 1000;
  let stopped = false;
  let child = null;
  function launch() {
    const startedAt = Date.now();
    child = spawnFn(nodePath, [cliPath, "watch", "--dir", workspaceRoot], { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.on("close", () => {
      if (stopped) return;
      delay = Date.now() - startedAt > 60000 ? 1000 : Math.min(delay * 2, maxDelayMs);
      setTimeout(launch, delay);
    });
  }
  launch();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}

module.exports = { SERVICE_NAME, planAutostart, installAutostart, removeAutostart, isAutostartInstalled, keepAlive };
