"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * The owner's projects, found rather than asked for. Any folder with a Git
 * history in the usual places counts, and its GitHub address is read from the
 * folder itself. Nothing leaves the computer, and nothing here is typed in.
 */
const USUAL_PLACES = ["GitHub", "github", "code", "Code", "projects", "Projects", "dev", "src", "repos", path.join("source", "repos"), path.join("Documents", "GitHub")];
const MAX_PROJECTS = 60;
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

/** owner/name from a remote address, with any sign-in details dropped. */
function repoFromRemote(url) {
  const match = /(?:github\.com|gitlab\.com|bitbucket\.org)[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function readRepo(folder) {
  try {
    const config = fs.readFileSync(path.join(folder, ".git", "config"), "utf8");
    const origin = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config);
    return origin ? repoFromRemote(origin[1]) : null;
  } catch {
    return null;
  }
}

function defaultRoots(workspaceRoot, homeDir = os.homedir()) {
  const roots = [workspaceRoot && path.dirname(path.resolve(workspaceRoot)), ...USUAL_PLACES.map(place => path.join(homeDir, place))];
  const seen = new Set();
  return roots.filter(root => {
    if (!root) return false;
    const key = root.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    try { return fs.statSync(root).isDirectory(); } catch { return false; }
  });
}

function discoverProjects({ roots = [] } = {}) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const folder = path.join(root, entry.name);
      const key = folder.toLowerCase();
      if (seen.has(key) || !fs.existsSync(path.join(folder, ".git"))) continue;
      seen.add(key);
      let touched = 0;
      try { touched = fs.statSync(folder).mtimeMs; } catch { /* keep 0 */ }
      found.push({ name: entry.name, path: folder, repo: readRepo(folder), touched });
    }
  }
  return found.sort((a, b) => b.touched - a.touched).slice(0, MAX_PROJECTS).map(({ touched, ...project }) => project);
}

/** Projects the owner pinned in their workspace come first; the rest are found. */
function listProjects(manifest, { workspaceRoot = process.cwd(), homeDir = os.homedir(), now = Date.now } = {}) {
  const pinned = (Array.isArray(manifest?.projects) ? manifest.projects : [])
    .filter(project => project && typeof project.name === "string" && typeof project.path === "string")
    .map(project => ({ name: project.name, path: path.resolve(project.path), repo: project.repo || readRepo(project.path) }));
  const key = `${path.resolve(workspaceRoot)}|${homeDir}`;
  if (!cache || cache.key !== key || now() - cache.at > CACHE_MS) {
    cache = { key, at: now(), value: discoverProjects({ roots: defaultRoots(workspaceRoot, homeDir) }) };
  }
  const taken = new Set(pinned.map(project => project.path.toLowerCase()));
  return [...pinned, ...cache.value.filter(project => !taken.has(project.path.toLowerCase()))];
}

const plain = text => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A project by its folder name or its GitHub name. Only ever one from the known list. */
function resolveProject(name, projects) {
  const wanted = plain(name);
  if (!wanted) return null;
  return projects.find(project => plain(project.name) === wanted) ||
    projects.find(project => project.repo && (plain(project.repo) === wanted || plain(project.repo.split("/")[1]) === wanted)) ||
    null;
}

/** If what the owner said names exactly one known project, that is the one they mean. */
function projectNamedIn(text, projects) {
  const said = ` ${plain(text)} `;
  const hits = projects.filter(project => {
    const names = [plain(project.name), project.repo ? plain(project.repo.split("/")[1]) : ""].filter(name => name.length >= 4);
    return names.some(name => said.includes(` ${name} `));
  });
  return hits.length === 1 ? hits[0] : null;
}

module.exports = { discoverProjects, defaultRoots, listProjects, resolveProject, projectNamedIn, repoFromRemote };
