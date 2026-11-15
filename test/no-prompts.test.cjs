"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findHarness } = require("../lib/harness-registry.cjs");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createNoticeBook } = require("../lib/notices.cjs");
const { dispatchBoardTask, buildWorkOrderPrompt, parseAgentReport } = require("../lib/os-runtime.cjs");
const { continuePlan } = require("../lib/continue-task.cjs");

test("background agents never wait on a prompt, and the buying checks stay attached", () => {
  const claude = findHarness("claude").run;
  const write = claude.args({ mode: "write", settingsFile: "C:/tmp/guard.json" });
  assert.equal(write[write.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.deepEqual(write.slice(write.indexOf("--settings"), write.indexOf("--settings") + 2), ["--settings", "C:/tmp/guard.json"]);
  assert.match(JSON.stringify(claude.settings()), /no-purchase\.cjs/);
  const read = claude.args({ mode: "read" });
  assert.equal(read[read.indexOf("--permission-mode") + 1], "plan");

  const opencode = findHarness("opencode").run;
  for (const mode of ["write", "read"]) assert.ok(opencode.args({ mode, cwd: "C:/work" }).includes("--auto"));
  assert.match(opencode.env.OPENCODE_CONFIG_CONTENT, /"\*domains buy\*":"deny"/);

  // Codex keeps its no-internet sandbox, which is its buying block, and is told how to ask for the web.
  const codex = findHarness("codex").run;
  assert.ok(codex.args({ mode: "write" }).join(" ").includes("sandbox_workspace_write.network_access=false"));
  assert.match(codex.writeNote, /AIOS-NEEDS-WEB:/);
});

test("an agent's request for a web lookup is read from its answer", () => {
  const report = parseAgentReport("Built the page shell.\n**AIOS-NEEDS-WEB: the fields Stripe Checkout returns today, for the success page**\nStill to run: npm install");
  assert.deepEqual(report.needsWeb, ["the fields Stripe Checkout returns today, for the success page"]);
  assert.doesNotMatch(report.note, /AIOS-NEEDS-WEB/);
});

test("Codex asks for the web, Antigravity looks it up, and Codex carries on with the answer by itself", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-web-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boardDir = path.join(dir, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const notices = createNoticeBook({ dir: boardDir });
  const manifest = { board: { localDir: boardDir }, ideology: { routerFunnel: "Muse" }, settings: { autoAudit: false },
    roles: { orchestrator: "muse", builder: "codex", auditor: "claude", researcher: "antigravity" } };
  const build = board.addTask({ task: "Build the checkout success page", to: "codex", meta: { role: "builder", kind: "build", project: "shop" } });
  const prompts = [];
  const runner = async ({ agent, prompt, mode }) => {
    prompts.push({ agent, mode, prompt });
    if (agent === "codex" && prompts.filter(p => p.agent === "codex").length === 1) {
      return { status: "Done", note: "Built the page shell.", needsWeb: ["the fields Stripe Checkout returns today"] };
    }
    if (agent === "antigravity") return { status: "Done", note: "Stripe Checkout returns id, amount_total and customer_details (https://docs.stripe.com/api/checkout/sessions)." };
    return { status: "Done", note: "Finished the success page." };
  };
  const available = { codex: true, antigravity: true, claude: true };

  await dispatchBoardTask({ workspaceRoot: dir, manifest, board, notices, taskId: build.ID, runner, availability: available });
  const waiting = board.getMeta(build.ID);
  assert.equal(board.findTask(build.ID).Status, "Waiting on User");
  const lookup = board.findTask(waiting.waitingFor);
  assert.deepEqual([lookup.Status, lookup.To], ["Open", "antigravity"]);
  assert.match(lookup.Task, /Stripe Checkout returns today/);
  assert.equal(board.getMeta(lookup.ID).resumes, build.ID);
  assert.match(waiting.answer, /Antigravity is looking it up/);
  // While the lookup runs, there is nothing for the owner to press on the build.
  const statusOf = id => board.findTask(id)?.Status;
  assert.equal(continuePlan({ row: board.findTask(build.ID), meta: waiting, notices: notices.listOpen(), manifest, availability: available, statusOf }).action, "none");

  await dispatchBoardTask({ workspaceRoot: dir, manifest, board, notices, taskId: lookup.ID, runner, availability: available });
  assert.equal(prompts.at(-1).mode, "read");
  const resumed = board.getMeta(build.ID);
  assert.deepEqual([board.findTask(build.ID).Status, board.findTask(build.ID).To], ["Open", "codex"]);
  assert.equal(resumed.waitingFor, null);
  assert.equal(resumed.continuation.kind, "web");
  const prompt = buildWorkOrderPrompt(board.findTask(build.ID), manifest, resumed);
  assert.match(prompt, /## What was looked up for you/);
  assert.match(prompt, /amount_total and customer_details/);

  await dispatchBoardTask({ workspaceRoot: dir, manifest, board, notices, taskId: build.ID, runner, availability: available });
  assert.equal(board.findTask(build.ID).Status, "Done");
  assert.equal(board.getMeta(build.ID).continuation, null);
  assert.match(prompts.at(-1).prompt, /amount_total and customer_details/);
});
