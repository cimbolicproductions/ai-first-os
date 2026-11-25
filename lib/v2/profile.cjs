"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/**
 * Private user profile and multi-root project registry.
 *
 * Lives strictly outside the public repository (~/.aios/profile.json by default,
 * overridable with AIOS_HOME). No personal paths, Tailscale addresses, Sheet IDs,
 * or business repo names belong inside the codebase.
 */

const STAKES_LEVELS = Object.freeze(["critical", "standard", "sandbox"]);
const MERGE_POLICIES = Object.freeze(["ask", "auto"]);
const DEFAULT_ROOT_NAMES = Object.freeze(["Projects", "projects", "GitHub", "github", "code", "Code", "repos", "dev", "src"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".aios", "dist", "build", ".next", "_wake-worktrees", "_live-worktrees", "worktrees"]);
const MAX_PROJECTS = 120;

function defaultProfileDir({ env = process.env, homeDir = os.homedir() } = {}) {
  return path.resolve(env.AIOS_HOME || path.join(homeDir, ".aios"));
}

function defaultProfile({ homeDir = os.homedir() } = {}) {
  const roots = DEFAULT_ROOT_NAMES
    .map(name => path.join(homeDir, name))
    .filter(dir => {
      try { return fs.statSync(dir).isDirectory(); } catch { return false; }
    });
  return {
    version: 2,
    owner: "Owner",
    vaultPath: null,
    projectRoots: roots,
    newProjectsRoot: roots[0] || path.join(homeDir, "Projects"),
    projects: [],
    stakesDefaults: {
      critical: { mergePolicy: "ask" },
      standard: { mergePolicy: "ask" },
      sandbox: { mergePolicy: "auto" },
    },
    models: {
      preferBelowApex: true,
      effortFirst: true,
      autoPromoteSandbox: false,
      overrides: {},
      disabledProviders: [],
      removedModels: [],
    },
    transport: {
      mode: "direct",
      host: "127.0.0.1",
      port: 4318,
      tailscaleHost: null,
      sshWakeDir: null,
      relay: null,
    },
    connectors: {
      muse: { enabled: false },
      grokbot: { enabled: false, dataDir: null },
      sheetsSync: { enabled: false, boardId: null, provider: "codex" },
    },
  };
}

function normalizeStakes(value, fallback = "standard") {
  const clean = String(value || "").toLowerCase().trim();
  return STAKES_LEVELS.includes(clean) ? clean : fallback;
}

function normalizeMergePolicy(value, fallback = "ask") {
  const clean = String(value || "").toLowerCase().trim();
  return MERGE_POLICIES.includes(clean) ? clean : fallback;
}

function normalizeProfile(raw, { homeDir = os.homedir() } = {}) {
  const base = defaultProfile({ homeDir });
  const input = raw && typeof raw === "object" ? raw : {};
  const projects = Array.isArray(input.projects)
    ? input.projects
      .filter(item => item && typeof item.name === "string" && typeof item.path === "string")
      .map(item => {
        const stakes = normalizeStakes(item.stakes, "standard");
        const defaultMerge = stakes === "sandbox" ? "auto" : "ask";
        return {
          name: item.name.trim(),
          path: path.resolve(item.path),
          repo: typeof item.repo === "string" && item.repo.trim() ? item.repo.trim() : null,
          stakes,
          mergePolicy: normalizeMergePolicy(item.mergePolicy, defaultMerge),
          aliases: Array.isArray(item.aliases) ? item.aliases.filter(a => typeof a === "string" && a.trim()).map(a => a.trim()) : [],
          createdByOs: item.createdByOs === true,
        };
      })
    : [];

  return {
    ...base,
    ...input,
    version: 2,
    owner: typeof input.owner === "string" && input.owner.trim() ? input.owner.trim() : base.owner,
    vaultPath: typeof input.vaultPath === "string" && input.vaultPath.trim() ? path.resolve(input.vaultPath) : null,
    projectRoots: Array.isArray(input.projectRoots)
      ? [...new Set(input.projectRoots.filter(r => typeof r === "string" && r.trim()).map(r => path.resolve(r)))]
      : base.projectRoots,
    newProjectsRoot: typeof input.newProjectsRoot === "string" && input.newProjectsRoot.trim()
      ? path.resolve(input.newProjectsRoot)
      : (Array.isArray(input.projectRoots) && input.projectRoots[0] ? path.resolve(input.projectRoots[0]) : base.newProjectsRoot),
    projects,
    stakesDefaults: {
      critical: { mergePolicy: normalizeMergePolicy(input.stakesDefaults?.critical?.mergePolicy, "ask") },
      standard: { mergePolicy: normalizeMergePolicy(input.stakesDefaults?.standard?.mergePolicy, "ask") },
      sandbox: { mergePolicy: normalizeMergePolicy(input.stakesDefaults?.sandbox?.mergePolicy, "auto") },
    },
    models: {
      ...base.models,
      ...(input.models && typeof input.models === "object" ? input.models : {}),
      effortFirst: input.models?.effortFirst !== false,
      overrides: input.models?.overrides && typeof input.models.overrides === "object" ? { ...input.models.overrides } : {},
      disabledProviders: Array.isArray(input.models?.disabledProviders)
        ? [...new Set(input.models.disabledProviders.filter(v => typeof v === "string" && v.trim()).map(v => v.trim().toLowerCase()))]
        : [],
      removedModels: Array.isArray(input.models?.removedModels)
        ? [...new Set(input.models.removedModels.filter(v => typeof v === "string" && v.trim()).map(v => v.trim()))]
        : [],
    },
    transport: {
      ...base.transport,
      ...(input.transport && typeof input.transport === "object" ? input.transport : {}),
    },
    connectors: {
      muse: { ...base.connectors.muse, ...(input.connectors?.muse || {}) },
      grokbot: { ...base.connectors.grokbot, ...(input.connectors?.grokbot || {}) },
      sheetsSync: { ...base.connectors.sheetsSync, ...(input.connectors?.sheetsSync || {}) },
    },
  };
}

function profileFilePath(profileDir = defaultProfileDir()) {
  return path.join(path.resolve(profileDir), "profile.json");
}

function loadProfile({ profileDir = defaultProfileDir(), homeDir = os.homedir() } = {}) {
  const file = profileFilePath(profileDir);
  if (!fs.existsSync(file)) return normalizeProfile({}, { homeDir });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return normalizeProfile(parsed, { homeDir });
}

function saveProfile(profile, { profileDir = defaultProfileDir(), homeDir = os.homedir() } = {}) {
  const dir = path.resolve(profileDir);
  const file = profileFilePath(dir);
  const clean = normalizeProfile(profile, { homeDir });
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return clean;
}

/** Extracts owner/name from git remote URL while dropping any credentials. */
function repoFromRemote(url) {
  const match = /(?:github\.com|gitlab\.com|bitbucket\.org)[:/]+([^/\s@]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function readGitRepo(folder) {
  try {
    const gitPath = path.join(folder, ".git");
    if (!fs.existsSync(gitPath)) return null;
    const stat = fs.statSync(gitPath);
    if (!stat.isDirectory()) return null;
    const cfg = fs.readFileSync(path.join(gitPath, "config"), "utf8");
    const match = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    return match ? repoFromRemote(match[1]) : null;
  } catch {
    return null;
  }
}

function isGitRepoRoot(folder) {
  try {
    const gitPath = path.join(folder, ".git");
    return fs.existsSync(gitPath) && fs.statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function scanRootForRepos(root, { maxDepth = 2 } = {}) {
  const found = [];
  const seen = new Set();
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      if (isGitRepoRoot(full)) {
        seen.add(key);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* keep 0 */ }
        found.push({
          name: entry.name,
          path: full,
          repo: readGitRepo(full),
          stakes: "standard",
          mergePolicy: "ask",
          aliases: [],
          createdByOs: false,
          mtime,
        });
      } else if (depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  }
  walk(root, 1);
  return found;
}

function listAllProjects(profile, { maxDepth = 2 } = {}) {
  const pinned = (profile?.projects || []).map(item => ({
    ...item,
    repo: item.repo || readGitRepo(item.path),
  }));
  const seenPaths = new Set(pinned.map(item => path.resolve(item.path).toLowerCase()));
  const discovered = [];
  for (const root of profile?.projectRoots || []) {
    if (!fs.existsSync(root)) continue;
    for (const found of scanRootForRepos(root, { maxDepth })) {
      const key = path.resolve(found.path).toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      discovered.push(found);
    }
  }
  discovered.sort((a, b) => b.mtime - a.mtime);
  return [...pinned, ...discovered.slice(0, Math.max(0, MAX_PROJECTS - pinned.length)).map(({ mtime, ...item }) => item)];
}

/** Normalizes text for resilient matching ("AcmeBilling" == "Acme Billing" == "acme-billing"). */
function compactKey(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function spacedKey(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function projectTokens(project) {
  const names = [
    project.name,
    ...(project.aliases || []),
    project.repo || "",
    project.repo ? project.repo.split("/")[1] : "",
  ].filter(Boolean);
  return [...new Set(names)];
}

/** Matches a project by exact name/alias/repo, or unambiguous mention in free text. */
function resolveProject(query, projects = []) {
  const raw = String(query || "").trim();
  if (!raw || !projects.length) return null;
  const qCompact = compactKey(raw);
  const qSpaced = spacedKey(raw);

  // 1. Exact match on name, alias, or repo slug (punctuation/space-insensitive).
  const exact = projects.filter(project =>
    projectTokens(project).some(token => {
      const tc = compactKey(token);
      return tc.length >= 3 && tc === qCompact;
    })
  );
  if (exact.length === 1) return exact[0];

  // 2. Mention inside a sentence: check word-bounded spaced phrase OR compact match for long tokens.
  const paddedSpaced = ` ${qSpaced} `;
  const hits = projects.filter(project =>
    projectTokens(project).some(token => {
      const ts = spacedKey(token);
      const tc = compactKey(token);
      if (ts.length >= 4 && paddedSpaced.includes(` ${ts} `)) return true;
      if (tc.length >= 6 && qCompact.includes(tc)) return true;
      return false;
    })
  );
  return hits.length === 1 ? hits[0] : null;
}

function stakesForProject(project, profile) {
  if (!project) return "sandbox";
  return normalizeStakes(project.stakes, "standard");
}

function mergePolicyForProject(project, profile) {
  const stakes = stakesForProject(project, profile);
  if (project?.mergePolicy) return normalizeMergePolicy(project.mergePolicy, "ask");
  return normalizeMergePolicy(profile?.stakesDefaults?.[stakes]?.mergePolicy, stakes === "sandbox" ? "auto" : "ask");
}

function slugifyProject(name) {
  const clean = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return /^[a-z0-9][a-z0-9-]{1,47}$/.test(clean) ? clean : null;
}

function defaultRunGit(args, { cwd }) {
  return new Promise(resolve => {
    const child = spawn(process.platform === "win32" ? "git.exe" : "git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", err => resolve({ code: 127, missing: err.code === "ENOENT", stdout, stderr: err.message }));
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function createManagedProject({ profile, profileDir = defaultProfileDir(), name, stakes = "sandbox", runGit = defaultRunGit }) {
  const slug = slugifyProject(name);
  if (!slug) throw Object.assign(new Error("Invalid project name."), { code: "BAD_PROJECT_NAME" });
  const existing = (profile.projects || []).find(item => item.name === slug);
  if (existing?.createdByOs) return existing;
  if (existing) throw Object.assign(new Error(`Project "${slug}" already exists.`), { code: "PROJECT_EXISTS" });

  const baseRoot = profile.newProjectsRoot || profile.projectRoots?.[0] || path.join(os.homedir(), "Projects");
  const folder = path.join(path.resolve(baseRoot), slug);
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  try {
    fs.mkdirSync(folder);
  } catch (err) {
    if (err.code === "EEXIST") throw Object.assign(new Error(`Folder "${slug}" already exists.`), { code: "PROJECT_EXISTS" });
    throw err;
  }

  const init = await runGit(["init", "-b", "main"], { cwd: folder });
  if (init.code !== 0) {
    const fallback = await runGit(["init"], { cwd: folder });
    if (fallback.code !== 0) {
      try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* ignore */ }
      throw Object.assign(new Error("Could not initialize git repository."), { code: "GIT_INIT_FAILED", gitMissing: fallback.missing === true });
    }
  }
  // Create an initial empty commit so isolated worktrees can immediately branch off HEAD.
  const readme = path.join(folder, "README.md");
  fs.writeFileSync(readme, `# ${slug}\n`, "utf8");
  await runGit(["add", "README.md"], { cwd: folder });
  let commit = await runGit(["commit", "-m", "chore: initialize project"], { cwd: folder });
  if (commit.code !== 0) {
    commit = await runGit(["-c", "user.name=AI-first OS", "-c", "user.email=aios@localhost", "commit", "-m", "chore: initialize project"], { cwd: folder });
  }
  if (commit.code !== 0) {
    throw Object.assign(new Error("Could not create initial commit."), { code: "GIT_COMMIT_FAILED" });
  }

  const cleanStakes = normalizeStakes(stakes, "sandbox");
  const project = {
    name: slug,
    path: folder,
    repo: null,
    stakes: cleanStakes,
    mergePolicy: cleanStakes === "sandbox" ? "auto" : "ask",
    aliases: [],
    createdByOs: true,
  };
  profile.projects = [...(profile.projects || []), project];
  saveProfile(profile, { profileDir });
  return project;
}

module.exports = {
  STAKES_LEVELS,
  MERGE_POLICIES,
  defaultProfileDir,
  defaultProfile,
  normalizeProfile,
  profileFilePath,
  loadProfile,
  saveProfile,
  repoFromRemote,
  readGitRepo,
  listAllProjects,
  resolveProject,
  stakesForProject,
  mergePolicyForProject,
  slugifyProject,
  createManagedProject,
};
