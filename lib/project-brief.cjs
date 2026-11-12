"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * One brief per project, in the owner's vault. It says what the project is for,
 * where it lives, where it stands, what comes next, and what happened, in order.
 * The software writes it as work moves, so any agent, on any day, can open one
 * file and carry on. Nobody has to remember to take notes.
 */
const GENERAL = "General";
const SECTIONS = ["Goal", "What the owner said", "Where it lives", "Where it stands", "Next", "Log"];
const MAX_LOG_LINES = 400;

const oneLine = (text, max = 400) => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

function fileName(name) {
  const safe = String(name || GENERAL).replace(/[^A-Za-z0-9 _.-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80);
  return (safe || GENERAL) + ".md";
}

function briefPath(manifest, projectName) {
  return path.join(manifest.vaultPath, "04_Projects", "Active", fileName(projectName));
}

function parse(text) {
  const brief = { title: "", sections: Object.fromEntries(SECTIONS.map(name => [name, []])) };
  let current = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line);
    if (/^# /.test(line) && !brief.title) brief.title = line.slice(2).trim();
    else if (heading) current = SECTIONS.includes(heading[1].trim()) ? heading[1].trim() : null;
    else if (current && line.trim()) brief.sections[current].push(line);
  }
  return brief;
}

function render(brief) {
  const lines = [`# ${brief.title}`, ""];
  for (const name of SECTIONS) {
    lines.push(`## ${name}`, ...(brief.sections[name].length ? brief.sections[name] : ["Nothing yet."]), "");
  }
  return lines.join("\n");
}

function load(file, title) {
  const brief = fs.existsSync(file) ? parse(fs.readFileSync(file, "utf8")) : parse("");
  if (!brief.title) brief.title = title;
  for (const name of SECTIONS) {
    if (brief.sections[name].length === 1 && brief.sections[name][0] === "Nothing yet.") brief.sections[name] = [];
  }
  return brief;
}

function save(file, brief) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, render(brief), "utf8");
  fs.renameSync(tmp, file);
}

const NEXT_STEPS = {
  asked: "Waiting for the owner to answer the organizer's question.",
  planned: "A worker is about to start.",
  built: "Finished. No outside check was asked for.",
  "built-checking": "Being checked by another agent. Nothing is needed from the owner.",
  findings: "The builder is fixing what the check found. It will be checked again after.",
  fixed: "Fixes are in. Waiting for the next check.",
  clean: "Checked and clean. Nothing is open. Ask for the next change when ready.",
  researched: "Research is done. Decide what to build from it.",
  stuck: "Stopped and waiting on the owner. See the latest log line.",
};

/**
 * Records one thing that happened. Creates the brief the first time, with the
 * goal in the owner's own words.
 */
function recordBriefEvent({ manifest, project = null, row, kind, who, text, goal = null, ownerWords = [], date = new Date() }) {
  if (!manifest?.vaultPath) return null;
  const name = project?.name || GENERAL;
  const file = briefPath(manifest, name);
  const brief = load(file, name);
  const day = new Date(date).toISOString().slice(0, 10);

  if (goal && !brief.sections.Goal.length) brief.sections.Goal = [oneLine(goal, 1200)];
  for (const words of ownerWords) {
    const line = `- ${oneLine(words, 600)}`;
    if (!brief.sections["What the owner said"].includes(line)) brief.sections["What the owner said"].push(line);
  }
  if (project?.path) {
    brief.sections["Where it lives"] = [`- Folder: ${project.path}`, ...(project.repo ? [`- GitHub: ${project.repo}`] : [])];
  }
  const verbs = { asked: "asked", planned: "planned", built: "built", "built-checking": "built", findings: "checked and found", fixed: "fixed", clean: "checked", researched: "researched", stuck: "stopped" };
  const entry = `- ${day} ${row} · ${who} ${verbs[kind] || kind}: ${oneLine(text)}`;
  if (brief.sections.Log.at(-1) !== entry) brief.sections.Log.push(entry);
  brief.sections.Log = brief.sections.Log.slice(-MAX_LOG_LINES);
  brief.sections["Where it stands"] = [`${day}: ${who} ${verbs[kind] || kind} ${row}. ${oneLine(text, 240)}`];
  brief.sections.Next = [NEXT_STEPS[kind] || "See the latest log line."];
  save(file, brief);
  return file;
}

function readBrief(manifest, projectName) {
  const file = briefPath(manifest, projectName || GENERAL);
  return fs.existsSync(file) ? { file, ...load(file, projectName || GENERAL) } : null;
}

module.exports = { recordBriefEvent, readBrief, briefPath, GENERAL };
