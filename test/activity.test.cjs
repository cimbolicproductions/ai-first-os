"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLocalBoard } = require("../adapters/local-board.cjs");
const { createActivity, describeTool, readClaudeEvent, plainLine } = require("../lib/activity.cjs");
const { defaultCliRunner, dispatchBoardTask } = require("../lib/os-runtime.cjs");
const { createDesktopServer } = require("../lib/desktop-hud.cjs");

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-activity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("what an agent is doing is said in a few plain words, and never leaks a command or a secret", () => {
  assert.equal(describeTool("Read", { file_path: "C:\\site\\src\\index.html" }), "Reading index.html");
  assert.equal(describeTool("Edit", { file_path: "/site/styles.css" }), "Writing styles.css");
  assert.equal(describeTool("Bash", { command: "npm test -- --token=abc123" }), "Running npm");
  assert.equal(describeTool("Grep", { pattern: "password" }), "Searching the project");
  assert.equal(describeTool("mcp__github__create_pr", {}), "Using github");

  const tool = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "about.html" } }] } });
  assert.deepEqual(readClaudeEvent(tool), { activity: "Writing about.html" });
  assert.deepEqual(readClaudeEvent(JSON.stringify({ type: "result", result: "All done." })), { result: "All done." });
  assert.equal(readClaudeEvent("not json"), null);

  assert.equal(plainLine("  Running the test suite  "), "Running the test suite");
  assert.equal(plainLine("export API_KEY=sk-live-123"), null);
  assert.equal(plainLine("AIOS-RESULT: {}"), null);
  assert.equal(plainLine("-----"), null);
});

test("a streamed run shows its steps live and still hands back the final answer", async t => {
  const dir = tempDir(t);
  const events = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "note.txt" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "page.html" } }] } },
    { type: "result", result: "Added the page and checked it." },
  ];
  let args = null;
  const spawnFn = (file, spawnArgs) => {
    args = spawnArgs.join(" ");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.stdin = Object.assign(new EventEmitter(), { end() {
      setImmediate(() => {
        // Split mid-line on purpose: output never arrives in tidy lines.
        const text = events.map(event => JSON.stringify(event)).join("\n") + "\n";
        child.stdout.emit("data", text.slice(0, 70));
        child.stdout.emit("data", text.slice(70));
        child.emit("close", 0);
      });
    } });
    child.kill = () => {};
    return child;
  };
  const seen = [];
  const outcome = await defaultCliRunner({
    agent: "claude", prompt: "Add a page", cwd: dir, task: { ID: "P1" }, mode: "write", spawnFn,
    detect: () => [{ id: "claude", workerPath: process.platform === "win32" ? "C:\\bin\\claude.exe" : "/bin/claude" }],
    onActivity: words => seen.push(words),
  });
  assert.match(args, /--output-format stream-json --verbose/);
  assert.deepEqual(seen, ["Reading note.txt", "Writing page.html"]);
  assert.deepEqual([outcome.status, outcome.note], ["Done", "Added the page and checked it."]);
});

test("the board shows the live line while a task runs, and clears it when the task ends", async t => {
  const dir = tempDir(t);
  const boardDir = path.join(dir, "board");
  const board = createLocalBoard({ boardDir, routerName: "Muse" });
  board.initBoard([], { empty: true });
  const manifest = { board: { mode: "local", localDir: boardDir }, ideology: { routerFunnel: "Muse" }, roles: { orchestrator: "muse", builder: "claude", auditor: "codex", researcher: "gemini" }, settings: { autoAudit: false } };
  const server = createDesktopServer({ workspaceRoot: dir, manifest, board, detect: () => [] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const view = async () => (await (await fetch(`${base}/api/state`)).json()).activity;

  board.addTask({ task: "Build the page", to: "claude" });
  let during = null;
  await dispatchBoardTask({
    workspaceRoot: dir, manifest, board, taskId: "P1", availability: { claude: true },
    runner: async ({ onActivity }) => {
      onActivity("Writing page.html");
      createActivity({ dir: boardDir }).set("P1", "claude", "Writing page.html", { force: true });
      during = await view();
      return { status: "Done", note: "Built." };
    },
  });
  assert.deepEqual([during.P1.agent, during.P1.text], ["claude", "Writing page.html"]);
  assert.deepEqual(await view(), {});

  const html = await (await fetch(base)).text();
  for (const tab of ["chat", "coding", "research", "tasks"]) assert.match(html, new RegExp(`data-view="${tab}"`));
  assert.match(html, /Get to work/);
});
