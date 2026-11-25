"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  runGitDefault, prepareWorktree, snapshotWorktree,
  commitWorktree, mergeBranchIntoRepo, removeWorktree, createProjectLockManager,
} = require("../../lib/v2/worktree.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await runGitDefault(["init", "-b", "main"], { cwd: dir });
  await runGitDefault(["config", "user.name", "Test"], { cwd: dir });
  await runGitDefault(["config", "user.email", "test@localhost"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "app.txt"), "v1\n", "utf8");
  await runGitDefault(["add", "app.txt"], { cwd: dir });
  await runGitDefault(["commit", "-m", "initial"], { cwd: dir });
}

test("worktree isolates edits from dirty main, captures untracked files in diff, and merges cleanly", async () => {
  const tmp = mkTmp("aios-v2-wt-");
  try {
    const repo = path.join(tmp, "demo-repo");
    const worktreesDir = path.join(tmp, "worktrees");
    await initRepo(repo);

    // Dirty the user's main checkout to prove prepareWorktree leaves it untouched.
    fs.writeFileSync(path.join(repo, "scratch.txt"), "unsaved local note\n", "utf8");

    const wt = await prepareWorktree({ repoPath: repo, taskId: "T42", worktreesDir });
    assert.equal(wt.branch, "aios/t42");
    assert.equal(wt.reused, false);
    assert.ok(fs.existsSync(path.join(wt.worktreePath, "app.txt")));
    assert.equal(fs.existsSync(path.join(wt.worktreePath, "scratch.txt")), false);

    // Make both a tracked edit and a brand-new untracked file inside the worktree.
    fs.writeFileSync(path.join(wt.worktreePath, "app.txt"), "v2\n", "utf8");
    fs.writeFileSync(path.join(wt.worktreePath, "new-feature.txt"), "hello world\n", "utf8");

    const snap = await snapshotWorktree(wt.worktreePath, { baseCommit: wt.baseCommit });
    assert.equal(snap.hasChanges, true);
    assert.deepEqual(snap.changedFiles, ["app.txt", "new-feature.txt"]);
    assert.match(snap.diff, /\+v2/);
    assert.match(snap.diff, /\+hello world/);

    const committed = await commitWorktree({ worktreePath: wt.worktreePath, message: "feat: add new feature" });
    assert.equal(committed.committed, true);

    // Merge refuses while source checkout is dirty, then succeeds once cleaned.
    const blockedMerge = await mergeBranchIntoRepo({ repoPath: repo, branch: wt.branch, baseBranch: "main" });
    assert.equal(blockedMerge.merged, false);
    assert.equal(blockedMerge.reason, "DIRTY_MAIN_REPO");

    fs.rmSync(path.join(repo, "scratch.txt"));
    const merged = await mergeBranchIntoRepo({ repoPath: repo, branch: wt.branch, baseBranch: "main" });
    assert.equal(merged.merged, true);
    assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8").replace(/\r\n/g, "\n"), "v2\n");
    assert.equal(fs.readFileSync(path.join(repo, "new-feature.txt"), "utf8").replace(/\r\n/g, "\n"), "hello world\n");

    await removeWorktree({ repoPath: repo, worktreePath: wt.worktreePath, branch: wt.branch, deleteBranch: true });
    assert.equal(fs.existsSync(wt.worktreePath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("worktree starts from fresher origin/main when local main is behind", async () => {
  const tmp = mkTmp("aios-v2-up-");
  try {
    const bare = path.join(tmp, "origin.git");
    const repo = path.join(tmp, "local");
    const other = path.join(tmp, "other");
    const worktreesDir = path.join(tmp, "worktrees");

    await runGitDefault(["init", "--bare", "-b", "main", bare], { cwd: tmp });
    await initRepo(repo);
    await runGitDefault(["remote", "add", "origin", bare], { cwd: repo });
    await runGitDefault(["push", "-u", "origin", "main"], { cwd: repo });

    // Advance origin via a second clone so local main is 1 commit behind.
    await runGitDefault(["clone", bare, other], { cwd: tmp });
    await runGitDefault(["config", "user.name", "Other"], { cwd: other });
    await runGitDefault(["config", "user.email", "other@localhost"], { cwd: other });
    fs.writeFileSync(path.join(other, "app.txt"), "upstream-v2\n", "utf8");
    await runGitDefault(["add", "app.txt"], { cwd: other });
    await runGitDefault(["commit", "-m", "upstream advance"], { cwd: other });
    await runGitDefault(["push", "origin", "main"], { cwd: other });

    const wt = await prepareWorktree({ repoPath: repo, taskId: "T99", worktreesDir });
    assert.equal(wt.fetchedUpstream, true);
    assert.equal(fs.readFileSync(path.join(wt.worktreePath, "app.txt"), "utf8").replace(/\r\n/g, "\n"), "upstream-v2\n");
    // Local checkout itself was never forcefully modified.
    assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8").replace(/\r\n/g, "\n"), "v1\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("per-project lock manager allows parallel builds across unrelated repos while serializing same repo", () => {
  const locks = createProjectLockManager();
  const relA = locks.tryAcquire("/repos/alpha", "T1");
  assert.ok(relA);
  // Same repo blocked:
  assert.equal(locks.tryAcquire("/repos/alpha", "T2"), null);
  // Unrelated repo runs in parallel:
  const relB = locks.tryAcquire("/repos/beta", "T3");
  assert.ok(relB);
  assert.equal(locks.activeCount(), 2);
  relA();
  assert.ok(locks.tryAcquire("/repos/alpha", "T2"));
  relB();
});
