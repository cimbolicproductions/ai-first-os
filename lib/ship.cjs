"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { locateBinary } = require("./agent-auth.cjs");
const { buildSpawnPlan, stopProcessTree } = require("./harness-registry.cjs");
const { getSetting } = require("./workspace.cjs");
const { offerDomain } = require("./domains.cjs");

/**
 * From "build me a site" to a folder, a private GitHub repository and a web
 * address, without the owner opening a terminal. Three rules hold throughout:
 * only projects this software created are ever pushed or put online, putting
 * something online is asked per project because anyone with the link can open
 * it, and no words from the board ever reach a command line.
 */
const isWin = process.platform === "win32";
const TOOLS = Object.freeze({
  git: isWin ? ["git.exe", "git.cmd"] : ["git"],
  gh: isWin ? ["gh.exe", "gh.cmd"] : ["gh"],
  vercel: isWin ? ["vercel.cmd", "vercel.exe"] : ["vercel"],
});
const SIGN_IN = Object.freeze({
  github: { tool: "gh", label: "GitHub", args: ["auth", "login", "--web", "--git-protocol", "https"], get: "https://cli.github.com" },
  vercel: { tool: "vercel", label: "Vercel", args: ["login"], get: "https://vercel.com/docs/cli" },
});

/** Runs one tool with fixed arguments. Resolves even when the tool is missing or fails. */
function defaultRun(tool, args, { cwd, timeoutMs = 240000 } = {}) {
  return new Promise(resolve => {
    const file = locateBinary(TOOLS[tool] || []);
    if (!file) return resolve({ code: 127, missing: true, stdout: "", stderr: "" });
    let plan;
    try { plan = buildSpawnPlan(file, args); } catch { return resolve({ code: 126, stdout: "", stderr: "unsafe arguments" }); }
    const child = spawn(plan.file, plan.args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...plan.options });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => stopProcessTree(child), timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: 127, missing: true, stdout, stderr }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** A folder and repository name: lowercase letters, digits and dashes, nothing else. */
function slug(name) {
  const clean = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(clean) ? clean : null;
}

function projectsHome(manifest, known = []) {
  if (manifest?.projectsHome) return path.resolve(manifest.projectsHome);
  if (known[0]?.path) return path.dirname(known[0].path);
  return path.join(os.homedir(), "Projects");
}

/** Makes the folder for something new, starts its history, and remembers it. */
async function createProject({ manifest, name, known = [], run = defaultRun, saveManifest = () => {} }) {
  const folderName = slug(name);
  if (!folderName) throw Object.assign(new Error("That project name cannot be used for a folder."), { code: "BAD_PROJECT_NAME" });
  const folder = path.join(projectsHome(manifest, known), folderName);
  const existed = fs.existsSync(folder);
  fs.mkdirSync(folder, { recursive: true });
  if (!fs.existsSync(path.join(folder, ".git"))) await run("git", ["init"], { cwd: folder });
  const project = { name: folderName, path: folder, repo: null, createdByOs: !existed };
  const pinned = Array.isArray(manifest.projects) ? manifest.projects : [];
  if (!pinned.some(item => item.name === folderName)) {
    manifest.projects = [...pinned, project];
    saveManifest(manifest);
  }
  return manifest.projects.find(item => item.name === folderName);
}

const ownProject = (manifest, name) =>
  (Array.isArray(manifest?.projects) ? manifest.projects : []).find(item => item.name === name && item.createdByOs === true) || null;

async function commitVersion({ project, version, run }) {
  await run("git", ["add", "-A"], { cwd: project.path });
  // The message goes in a file, never on the command line.
  const message = path.join(project.path, ".git", "AIOS_COMMIT_MESSAGE");
  fs.writeFileSync(message, `Version ${version}\n`, "utf8");
  let made = await run("git", ["commit", "-F", message], { cwd: project.path });
  if (made.code !== 0 && /identity|user\.email|user\.name/i.test(made.stdout + made.stderr)) {
    made = await run("git", ["-c", "user.name=AI-first OS", "-c", "user.email=aios@localhost", "commit", "-F", message], { cwd: project.path });
  }
  return { committed: made.code === 0 };
}

async function signedIn(service, run) {
  const check = service === "github" ? await run("gh", ["auth", "status"]) : await run("vercel", ["whoami"]);
  return { installed: !check.missing, ready: !check.missing && check.code === 0 };
}

async function pushToGithub({ project, run }) {
  const remote = await run("git", ["remote", "get-url", "origin"], { cwd: project.path });
  const pushed = remote.code === 0
    ? await run("git", ["push", "-u", "origin", "HEAD"], { cwd: project.path })
    : await run("gh", ["repo", "create", project.name, "--private", "--source", ".", "--remote", "origin", "--push"], { cwd: project.path });
  if (pushed.code !== 0) return { ok: false, detail: (pushed.stderr || pushed.stdout).trim().split(/\r?\n/).pop() || "" };
  const view = await run("gh", ["repo", "view", "--json", "url", "--jq", ".url"], { cwd: project.path });
  const url = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(view.stdout || "")?.[0] || null;
  return { ok: true, url };
}

async function deployToVercel({ project, run }) {
  // Production, so every finished version replaces the last one at the same address.
  const deployed = await run("vercel", ["deploy", "--prod", "--yes"], { cwd: project.path, timeoutMs: 600000 });
  // Vercel prints two addresses. The long one for this deployment can sit behind a Vercel
  // sign-in; the short one it is "Aliased" to is the one a person opens. Prefer the short one.
  const alias = /Aliased:\s*(https:\/\/[a-z0-9-]+\.vercel\.app)/i.exec(`${deployed.stdout || ""}\n${deployed.stderr || ""}`)?.[1];
  const url = alias || [...String(deployed.stdout || "").matchAll(/https:\/\/[a-z0-9-]+\.vercel\.app/gi)].map(match => match[0]).pop() || null;
  return deployed.code === 0 && url ? { ok: true, url } : { ok: false, detail: (deployed.stderr || deployed.stdout).trim().split(/\r?\n/).pop() || "" };
}

/**
 * After a version is finished: save it, then GitHub, then the web. Every step
 * that needs the owner raises one plain question and stops there.
 */
async function shipVersion({ board, root, manifest, notices, run = defaultRun, saveManifest = () => {} }) {
  const meta = board.getMeta(root);
  const project = meta.project ? ownProject(manifest, meta.project) : null;
  if (!project) return { skipped: true };
  const version = meta.version || 1;
  const done = { version };
  done.committed = (await commitVersion({ project, version, run })).committed;

  const connect = (service, then) => {
    const { label } = SIGN_IN[service];
    notices?.raise({
      row: root, kind: "blocked",
      text: `To put ${project.name} on ${label}, connect ${label} once. You approve it in your browser, and it is remembered.`,
      choices: [{ label: `Connect ${label}`, value: `connect:${service}` }],
      then: { type: "connect", row: root, next: then },
    });
  };

  const github = getSetting(manifest, "settings.ship.github");
  if (github === undefined) {
    notices?.raise({
      row: root, kind: "question",
      text: "Keep the projects I build for you on your GitHub, as private repositories only you can see?",
      choices: [{ label: "Yes, keep them on GitHub", value: "yes" }, { label: "Not now", value: "no" }],
      settingKey: "settings.ship.github",
      then: { type: "ship", row: root },
    });
    return { ...done, asked: "github" };
  }
  if (github === "yes" && meta.shippedVersion !== version) {
    if (!(await signedIn("github", run)).ready) { connect("github"); return { ...done, needs: "github" }; }
    const pushed = await pushToGithub({ project, run });
    if (!pushed.ok) {
      notices?.raise({ row: root, kind: "blocked", text: `I could not put ${project.name} on GitHub just now.`, choices: [{ label: "Try again", value: "retry" }], then: { type: "ship", row: root } });
      return { ...done, failed: "github", detail: pushed.detail };
    }
    done.repoUrl = pushed.url;
    if (pushed.url) project.repo = pushed.url.replace("https://github.com/", "");
    board.setMeta(root, { shippedVersion: version, repoUrl: pushed.url });
    saveManifest(manifest);
    notices?.raise({ row: root, kind: "done", text: `Version ${version} of ${project.name} is on your GitHub, private.${pushed.url ? " " + pushed.url : ""}` });
  }

  // Online means anyone with the link can open it, so this is asked for each project.
  if (project.online === undefined) {
    notices?.raise({
      row: root, kind: "question",
      text: `Put ${project.name} online so you can open it in a browser? It gets a web address, and anyone who has the link can open it.`,
      choices: [{ label: "Put it online", value: "yes" }, { label: "Not now", value: "no" }],
      then: { type: "online", row: root, project: project.name },
    });
    return { ...done, asked: "online" };
  }
  if (project.online === "yes" && meta.onlineVersion !== version) {
    if (!(await signedIn("vercel", run)).ready) { connect("vercel"); return { ...done, needs: "vercel" }; }
    const live = await deployToVercel({ project, run });
    if (!live.ok) {
      notices?.raise({ row: root, kind: "blocked", text: `I could not put ${project.name} online just now.`, choices: [{ label: "Try again", value: "retry" }], then: { type: "ship", row: root } });
      return { ...done, failed: "vercel", detail: live.detail };
    }
    done.liveUrl = live.url;
    board.setMeta(root, { onlineVersion: version, liveUrl: live.url });
    notices?.raise({ row: root, kind: "done", text: `Version ${version} of ${project.name} is online. ${live.url}` });
    if (notices) offerDomain({ project, row: root, liveUrl: live.url, notices, manifest, saveManifest });
  }
  return done;
}

/** Opens the service's own sign-in in its own window. If the tool is not installed, opens where to get it. */
function openConnectWindow(service, { platform = process.platform, spawnFn = spawn, env = process.env } = {}) {
  const spec = SIGN_IN[service];
  if (!spec) return { ok: false };
  const file = locateBinary(TOOLS[spec.tool]);
  const quiet = { detached: true, stdio: "ignore" };
  let child;
  if (!file) {
    child = platform === "win32" ? spawnFn(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `start "" "${spec.get}"`], { ...quiet, windowsVerbatimArguments: true })
      : spawnFn(platform === "darwin" ? "open" : "xdg-open", [spec.get], quiet);
  } else if (platform === "win32") {
    const inner = [`"${file}"`, ...spec.args].join(" ");
    child = spawnFn(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `start "Connect ${spec.label}" cmd /k "${inner}"`], { ...quiet, windowsVerbatimArguments: true });
  } else if (platform === "darwin") {
    child = spawnFn("osascript", ["-e", `tell application "Terminal" to do script "${[file, ...spec.args].join(" ").replace(/(["\\])/g, "\\$1")}"`], quiet);
  } else {
    child = spawnFn("x-terminal-emulator", ["-e", file, ...spec.args], quiet);
  }
  child?.on?.("error", () => {});
  child?.unref?.();
  return { ok: true, installed: Boolean(file) };
}

module.exports = { slug, projectsHome, createProject, ownProject, shipVersion, openConnectWindow, defaultRun, SIGN_IN };
