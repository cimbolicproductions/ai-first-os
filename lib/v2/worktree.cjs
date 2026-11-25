"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/**
 * Isolated Git Worktree Manager & Per-Project Concurrency Locks.
 *
 * Every builder runs in an isolated worktree under ~/.aios/worktrees/, never
 * directly on the user's checked-out main branch. Unrelated repos build in
 * parallel while tasks targeting the same repo serialize cleanly.
 */

const MAX_DIFF_BYTES = 120 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;

function runGitDefault(args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise(resolve => {
    const bin = process.platform === "win32" ? "git.exe" : "git";
    const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", err => {
      clearTimeout(timer);
      resolve({ code: 127, missing: err.code === "ENOENT", stdout, stderr: err.message });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function safeSlug(text) {
  return String(text || "repo").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
}

async function resolveBaseRef(repoPath, { runGit = runGitDefault } = {}) {
  const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
  if (head.code !== 0 || !head.stdout.trim()) {
    throw Object.assign(new Error("Repository has no commits yet."), { code: "NO_HEAD_COMMIT" });
  }
  const localHead = head.stdout.trim();
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
  const localBranch = branchRes.code === 0 ? branchRes.stdout.trim() : "main";

  // Check if origin remote exists and try fetching fresh upstream commits (without touching the user's checkout).
  const remoteRes = await runGit(["remote", "get-url", "origin"], { cwd: repoPath });
  if (remoteRes.code !== 0 || !remoteRes.stdout.trim()) {
    return { baseRef: localHead, baseBranch: localBranch, fetchedUpstream: false };
  }

  const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: repoPath });
  if (upstreamRes.code !== 0 || !upstreamRes.stdout.trim()) {
    return { baseRef: localHead, baseBranch: localBranch, fetchedUpstream: false };
  }
  const upstreamRef = upstreamRes.stdout.trim();
  const fetchRes = await runGit(["fetch", "--quiet", "origin"], { cwd: repoPath, timeoutMs: 30000 });
  if (fetchRes.code !== 0) {
    return { baseRef: localHead, baseBranch: localBranch, fetchedUpstream: false };
  }

  const counts = await runGit(["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`], { cwd: repoPath });
  if (counts.code === 0) {
    const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
    if (ahead === 0 && behind > 0) {
      const upCommit = await runGit(["rev-parse", upstreamRef], { cwd: repoPath });
      if (upCommit.code === 0 && upCommit.stdout.trim()) {
        return { baseRef: upCommit.stdout.trim(), baseBranch: localBranch, fetchedUpstream: true };
      }
    }
  }
  return { baseRef: localHead, baseBranch: localBranch, fetchedUpstream: true };
}

async function prepareWorktree({ repoPath, taskId, worktreesDir, runGit = runGitDefault }) {
  const absRepo = path.resolve(repoPath);
  if (!fs.existsSync(path.join(absRepo, ".git"))) {
    throw Object.assign(new Error(`Not a git repository: ${absRepo}`), { code: "NOT_GIT_REPO" });
  }
  const repoSlug = safeSlug(path.basename(absRepo));
  const safeTask = safeSlug(taskId);
  const branch = `aios/${safeTask}`;
  const worktreePath = path.join(path.resolve(worktreesDir), `${repoSlug}-${safeTask}`);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  const { baseRef, baseBranch, fetchedUpstream } = await resolveBaseRef(absRepo, { runGit });

  // Reuse an intact existing worktree when resuming a task.
  if (fs.existsSync(worktreePath) && fs.existsSync(path.join(worktreePath, ".git"))) {
    const status = await runGit(["status", "--porcelain"], { cwd: worktreePath });
    const head = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath });
    return {
      repoPath: absRepo,
      worktreePath,
      branch,
      baseBranch,
      baseCommit: head.stdout.trim() || baseRef,
      reused: true,
      dirty: Boolean(status.stdout.trim()),
      fetchedUpstream,
    };
  }

  // Prune stale worktree records before adding a new one.
  await runGit(["worktree", "prune"], { cwd: absRepo });

  // Check if branch already exists.
  const branchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: absRepo });
  const addArgs = branchExists.code === 0
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, baseRef];
  const added = await runGit(addArgs, { cwd: absRepo });
  if (added.code !== 0) {
    throw Object.assign(new Error(`Could not create worktree: ${added.stderr.trim() || added.stdout.trim()}`), { code: "WORKTREE_ADD_FAILED" });
  }

  return {
    repoPath: absRepo,
    worktreePath,
    branch,
    baseBranch,
    baseCommit: baseRef,
    reused: false,
    dirty: false,
    fetchedUpstream,
  };
}

/**
 * Deterministic workspace snapshot + full diff (including untracked files) so
 * auditors inspect real ground-truth changes instead of trusting builder prose.
 */
async function snapshotWorktree(worktreePath, { baseCommit = null, runGit = runGitDefault } = {}) {
  const abs = path.resolve(worktreePath);
  const headRes = await runGit(["rev-parse", "HEAD"], { cwd: abs });
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: abs });
  const statusRes = await runGit(["status", "--porcelain", "-uall"], { cwd: abs });
  const lines = statusRes.stdout.split(/\r?\n/).filter(Boolean);

  const changedFiles = [];
  const untrackedFiles = [];
  for (const line of lines) {
    const code = line.slice(0, 2);
    const rel = line.slice(3).replace(/^"|"$/g, "");
    changedFiles.push(rel);
    if (code === "??") untrackedFiles.push(rel);
  }

  // Also include files committed on the branch since baseCommit.
  if (baseCommit) {
    const committed = await runGit(["diff", "--name-only", `${baseCommit}..HEAD`], { cwd: abs });
    if (committed.code === 0) {
      for (const rel of committed.stdout.split(/\r?\n/).filter(Boolean)) {
        if (!changedFiles.includes(rel)) changedFiles.push(rel);
      }
    }
  }
  changedFiles.sort();

  const hasher = crypto.createHash("sha256");
  hasher.update(`HEAD:${headRes.stdout.trim()}\n`);
  for (const rel of changedFiles) {
    const full = path.join(abs, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const stat = fs.statSync(full);
      if (stat.size <= MAX_SNAPSHOT_FILE_BYTES) {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        hasher.update(`FILE:${rel}:${digest}\n`);
      } else {
        hasher.update(`LARGE:${rel}:${stat.size}\n`);
      }
    } else {
      hasher.update(`DELETED:${rel}\n`);
    }
  }

  // Build unified diff across tracked changes (+ branch commits) and untracked new files.
  const diffRef = baseCommit || "HEAD";
  const trackedDiff = await runGit(["diff", diffRef], { cwd: abs });
  let diffText = trackedDiff.stdout || "";
  for (const rel of untrackedFiles) {
    const full = path.join(abs, rel);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.size <= 32 * 1024) {
        const content = fs.readFileSync(full, "utf8");
        const added = content.split(/\r?\n/).map(l => `+${l}`).join("\n");
        diffText += `\ndiff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${content.split(/\r?\n/).length} @@\n${added}\n`;
      } else {
        diffText += `\ndiff --git a/${rel} b/${rel}\nnew binary/large file (${stat.size} bytes)\n`;
      }
    } catch { /* skip unreadable */ }
  }
  if (diffText.length > MAX_DIFF_BYTES) {
    diffText = diffText.slice(0, MAX_DIFF_BYTES) + "\n... [diff truncated at 120 KB] ...\n";
  }

  return {
    head: headRes.stdout.trim(),
    branch: branchRes.stdout.trim(),
    changedFiles,
    untrackedFiles,
    hasChanges: changedFiles.length > 0,
    fingerprint: hasher.digest("hex"),
    diff: diffText.trim(),
  };
}

async function commitWorktree({ worktreePath, message, runGit = runGitDefault }) {
  const abs = path.resolve(worktreePath);
  await runGit(["add", "-A"], { cwd: abs });
  const staged = await runGit(["diff", "--cached", "--name-only"], { cwd: abs });
  if (!staged.stdout.trim()) {
    const head = await runGit(["rev-parse", "HEAD"], { cwd: abs });
    return { committed: false, nothingToCommit: true, commitHash: head.stdout.trim() };
  }
  const msgFile = path.join(abs, ".git-aios-commit-msg");
  fs.writeFileSync(msgFile, String(message || "chore: AI-first OS update").trim() + "\n", "utf8");
  try {
    let res = await runGit(["commit", "-F", msgFile], { cwd: abs });
    if (res.code !== 0 && /identity|user\.email|user\.name/i.test(res.stdout + res.stderr)) {
      res = await runGit(["-c", "user.name=AI-first OS", "-c", "user.email=aios@localhost", "commit", "-F", msgFile], { cwd: abs });
    }
    if (res.code !== 0) {
      return { committed: false, error: (res.stderr || res.stdout).trim() };
    }
  } finally {
    fs.rmSync(msgFile, { force: true });
  }
  const head = await runGit(["rev-parse", "HEAD"], { cwd: abs });
  return { committed: true, commitHash: head.stdout.trim() };
}

/**
 * Merges a verified worktree branch into the target repo's default branch ONLY
 * when the target checkout is clean and merge is conflict-free.
 */
async function mergeBranchIntoRepo({ repoPath, branch, baseBranch = null, runGit = runGitDefault }) {
  const absRepo = path.resolve(repoPath);
  const dirty = await runGit(["status", "--porcelain"], { cwd: absRepo });
  if (dirty.stdout.trim()) {
    return { merged: false, reason: "DIRTY_MAIN_REPO", detail: "Source checkout has uncommitted changes; merge manually or clean checkout first." };
  }
  const currentBranch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: absRepo })).stdout.trim();
  const target = baseBranch || currentBranch;
  if (target && currentBranch !== target) {
    const checkout = await runGit(["checkout", target], { cwd: absRepo });
    if (checkout.code !== 0) {
      return { merged: false, reason: "CHECKOUT_FAILED", detail: checkout.stderr.trim() };
    }
  }
  const merge = await runGit(["merge", "--no-edit", branch], { cwd: absRepo });
  if (merge.code !== 0) {
    await runGit(["merge", "--abort"], { cwd: absRepo });
    return { merged: false, reason: "MERGE_CONFLICT", detail: (merge.stderr || merge.stdout).trim() };
  }
  const head = (await runGit(["rev-parse", "HEAD"], { cwd: absRepo })).stdout.trim();
  return { merged: true, commitHash: head, branch: target };
}

async function removeWorktree({ repoPath, worktreePath, branch = null, deleteBranch = false, runGit = runGitDefault }) {
  const absRepo = path.resolve(repoPath);
  const absWt = path.resolve(worktreePath);
  await runGit(["worktree", "remove", "--force", absWt], { cwd: absRepo });
  if (fs.existsSync(absWt)) {
    try { fs.rmSync(absWt, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  await runGit(["worktree", "prune"], { cwd: absRepo });
  if (deleteBranch && branch) {
    await runGit(["branch", "-d", branch], { cwd: absRepo });
  }
}

/** Per-project mutex: unrelated projects run in parallel; same project serializes. */
function createProjectLockManager() {
  const active = new Map();
  const keyOf = projectKey => String(projectKey || "__global__").toLowerCase();

  return {
    isLocked(projectKey) {
      return active.has(keyOf(projectKey));
    },
    activeCount() {
      return active.size;
    },
    activeKeys() {
      return [...active.keys()];
    },
    tryAcquire(projectKey, ownerId) {
      const k = keyOf(projectKey);
      if (active.has(k)) return null;
      active.set(k, ownerId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (active.get(k) === ownerId) active.delete(k);
      };
    },
  };
}

module.exports = {
  runGitDefault,
  resolveBaseRef,
  prepareWorktree,
  snapshotWorktree,
  commitWorktree,
  mergeBranchIntoRepo,
  removeWorktree,
  createProjectLockManager,
};
