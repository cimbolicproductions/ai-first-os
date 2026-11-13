"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { startConnect, safeLink } = require("../lib/connect.cjs");

/**
 * Stand-in processes. The sign-in prints what the real tool prints; the check
 * that follows answers with the exit code we choose. Nothing real is started.
 */
function fakeSpawn({ lines = [], signInCode = 0, checkCode = 0, holdOpen = false } = {}) {
  const started = [];
  const spawnFn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const typed = [];
    child.stdin = Object.assign(new EventEmitter(), { write: text => typed.push(text), end() {} });
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", null)); };
    const joined = args.join(" ");
    const isCheck = /whoami|auth status/.test(joined);
    started.push({ file, args: joined, typed, child });
    setImmediate(() => {
      if (isCheck) return child.emit("close", checkCode);
      for (const line of lines) child.stderr.emit("data", line + "\n");
      if (!holdOpen) setImmediate(() => child.emit("close", signInCode));
    });
    return child;
  };
  return { spawnFn, started };
}

test("Vercel: its approval page opens, the link is shown, and it reports signed in only when Vercel says so", async () => {
  const { spawnFn, started } = fakeSpawn({ lines: ["Vercel CLI 48.6.0", "", "  Visit https://vercel.com/oauth/device?user_code=HTZM-MDMZ", "  Press [ENTER] to open the browser"] });
  const opened = [];
  const prompts = [];
  const outcome = await startConnect("vercel", { spawnFn, locate: () => "/bin/vercel", openUrl: url => opened.push(url), onPrompt: p => prompts.push(p) });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(opened, ["https://vercel.com/oauth/device?user_code=HTZM-MDMZ"]);
  assert.deepEqual(prompts, [{ link: "https://vercel.com/oauth/device?user_code=HTZM-MDMZ", code: null }]);
  assert.deepEqual(started.map(s => s.args), ["login", "whoami"]);
  assert.deepEqual(started[0].typed, [], "Vercel waits on its own; nothing is typed into it");

  // The tool exiting cleanly is not proof. The check has the last word.
  const doubt = fakeSpawn({ lines: ["Visit https://vercel.com/oauth/device?user_code=AAAA-BBBB"], checkCode: 1 });
  assert.deepEqual(await startConnect("vercel", { spawnFn: doubt.spawnFn, locate: () => "/bin/vercel", openUrl: () => {} }), { ok: false, reason: "not_approved" });
});

test("GitHub: the one-time code is shown with its page, and the sign-in is told to go ahead", async () => {
  const { spawnFn, started } = fakeSpawn({ lines: ["! First copy your one-time code: 1A2B-3C4D", "Press Enter to open github.com in your browser..."] });
  const opened = [];
  const prompts = [];
  const outcome = await startConnect("github", { spawnFn, locate: () => "/bin/gh", openUrl: url => opened.push(url), onPrompt: p => prompts.push(p) });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(prompts, [{ link: "https://github.com/login/device", code: "1A2B-3C4D" }]);
  assert.deepEqual(started[0].typed, ["\n"], "Enter is pressed for the owner so GitHub opens its page and starts listening");
  assert.deepEqual(opened, [], "GitHub opens its own page");
  assert.equal(started[0].args, "auth login --web --hostname github.com --git-protocol https");
});

test("a link that is never approved expires, a missing tool sends the owner to get it, and only real sign-in pages are offered", async () => {
  const slow = fakeSpawn({ lines: ["Visit https://vercel.com/oauth/device?user_code=CCCC-DDDD"], holdOpen: true });
  assert.deepEqual(await startConnect("vercel", { spawnFn: slow.spawnFn, locate: () => "/bin/vercel", openUrl: () => {}, timeoutMs: 30 }), { ok: false, reason: "expired" });
  assert.equal(slow.started[0].child.killed, true, "the waiting sign-in is stopped, not left running");

  const opened = [];
  assert.deepEqual(await startConnect("vercel", { locate: () => null, openUrl: url => opened.push(url) }), { ok: false, reason: "missing" });
  assert.deepEqual(opened, ["https://vercel.com/docs/cli"]);

  // A sign-in that prints something else entirely never turns into a link.
  const odd = fakeSpawn({ lines: ["Visit https://vercel.com.evil.example/oauth/device?user_code=X"], signInCode: 1 });
  const prompts = [];
  assert.equal((await startConnect("vercel", { spawnFn: odd.spawnFn, locate: () => "/bin/vercel", openUrl: () => {}, onPrompt: p => prompts.push(p) })).ok, false);
  assert.deepEqual(prompts, []);
  assert.equal(safeLink("https://vercel.com.evil.example/x"), null);
  assert.equal(safeLink("http://vercel.com/oauth/device"), null);
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("https://github.com/login/device"), "https://github.com/login/device");
});
