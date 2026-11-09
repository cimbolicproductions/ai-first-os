"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

function obsidianConfigFile({ homeDir = os.homedir(), env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") return path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "obsidian", "obsidian.json");
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "obsidian", "obsidian.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "obsidian", "obsidian.json");
}

function hasObsidian(options = {}) {
  const { homeDir = os.homedir(), env = process.env, platform = process.platform } = options;
  const places = [
    obsidianConfigFile(options),
    path.join(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "Programs", "Obsidian", "Obsidian.exe"),
    "/Applications/Obsidian.app",
  ];
  return places.some((p, i) => (i === 0 || platform !== "linux") && fs.existsSync(p));
}

/** Makes a plain folder an Obsidian vault and adds it to Obsidian's own list. */
function makeObsidianVault(vaultPath, options = {}) {
  const dot = path.join(vaultPath, ".obsidian");
  fs.mkdirSync(dot, { recursive: true });
  const appFile = path.join(dot, "app.json");
  if (!fs.existsSync(appFile)) fs.writeFileSync(appFile, JSON.stringify({ alwaysUpdateLinks: true }, null, 2) + "\n", "utf8");

  const configFile = obsidianConfigFile(options);
  if (!fs.existsSync(configFile)) return { created: true, registered: false };
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
    return { created: true, registered: false };
  }
  config.vaults = config.vaults || {};
  const resolved = path.resolve(vaultPath);
  if (!Object.values(config.vaults).some(v => v.path === resolved)) {
    config.vaults[crypto.randomBytes(8).toString("hex")] = { path: resolved, ts: Date.now() };
    fs.writeFileSync(configFile, JSON.stringify(config), "utf8");
  }
  return { created: true, registered: true };
}

const SKILLS_FOLDER_NAME = "AI-first OS Skills";

function cloudFolders({ homeDir = os.homedir(), platform = process.platform } = {}) {
  const found = [];
  const add = (id, label, dir) => {
    if (dir && !found.some(f => f.id === id) && fs.existsSync(dir)) found.push({ id, label, path: path.join(dir, SKILLS_FOLDER_NAME) });
  };
  if (platform === "win32") {
    for (const drive of "GHIJ") add("drive", "Google Drive", `${drive}:\\My Drive`);
    add("icloud", "iCloud", path.join(homeDir, "iCloudDrive"));
  } else if (platform === "darwin") {
    const cloud = path.join(homeDir, "Library", "CloudStorage");
    if (fs.existsSync(cloud)) {
      const entry = fs.readdirSync(cloud).find(n => n.startsWith("GoogleDrive-"));
      if (entry) add("drive", "Google Drive", path.join(cloud, entry, "My Drive"));
    }
    add("icloud", "iCloud", path.join(homeDir, "Library", "Mobile Documents", "com~apple~CloudDocs"));
  } else {
    add("drive", "Google Drive", path.join(homeDir, "GoogleDrive"));
  }
  return found;
}

function skillsChoices(vaultPath, options = {}) {
  return [
    { id: "vault", label: "Inside my notes", path: path.join(vaultPath, "08_Systems_and_SOPs", "Skills") },
    ...cloudFolders(options),
  ];
}

/** One library. A folder the owner names wins; otherwise the vault's Skills folder. */
function resolveSkillsPath({ pick, customPath, vaultPath, options }) {
  if (customPath) return path.resolve(customPath);
  const choice = skillsChoices(vaultPath, options).find(c => c.id === pick);
  return choice ? choice.path : path.join(vaultPath, "08_Systems_and_SOPs", "Skills");
}

module.exports = { obsidianConfigFile, hasObsidian, makeObsidianVault, skillsChoices, resolveSkillsPath, SKILLS_FOLDER_NAME };
