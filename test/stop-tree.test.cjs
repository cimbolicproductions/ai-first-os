"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildSpawnPlan, stopProcessTree } = require("../lib/harness-registry.cjs");

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("stopping a process stops what it started, so a timed-out agent does not keep running", t => {
  const calls = [];
  const killed = [];
  const child = { pid: 4321, kill: () => killed.push("kill") };
  stopProcessTree(child, { platform: "win32", run: (file, args) => calls.push(`${file} ${args.join(" ")}`) });
  assert.deepEqual(calls, ["taskkill /pid 4321 /T /F"]);
  assert.deepEqual(killed, ["kill"]);

  calls.length = 0;
  stopProcessTree({ pid: 4321, kill: () => killed.push("kill") }, { platform: "linux", run: () => calls.push("x") });
  assert.deepEqual(calls, [], "elsewhere the process group ends with its parent");
});

test("on Windows, a program started through a command file is really stopped", { skip: process.platform !== "win32" && "Windows only" }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-stop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "pid.txt");
  const script = path.join(dir, "sleeper.js");
  fs.writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);\n`);
  const shim = path.join(dir, "sleeper.cmd");
  fs.writeFileSync(shim, `@"${process.execPath}" "${script}"\r\n`);

  const plan = buildSpawnPlan(shim, []);
  const child = spawn(plan.file, plan.args, { stdio: "ignore", windowsHide: true, ...plan.options });
  let inner = null;
  for (let i = 0; i < 100 && !inner; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (fs.existsSync(pidFile)) inner = Number(fs.readFileSync(pidFile, "utf8"));
  }
  assert.ok(inner && alive(inner), "the program behind the command file is running");
  stopProcessTree(child);
  for (let i = 0; i < 40 && alive(inner); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(inner), false, "and stopping the launcher stopped it too");
});
