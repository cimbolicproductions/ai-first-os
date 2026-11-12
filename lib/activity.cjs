"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * What each working agent is doing right now, in a few words. It is the mirror
 * in the elevator: the work is no faster, but nobody stares at a blank screen.
 * Kept beside the board, never in it, so it can change every second.
 */
const WRITE_EVERY_MS = 700;
const MAX_WORDS = 90;

const brief = text => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_WORDS ? flat.slice(0, MAX_WORDS - 1) + "…" : flat;
};
const baseName = file => String(file || "").split(/[\\/]/).filter(Boolean).pop() || "a file";

/** A tool call, said the way a person would say it. Never the command's own text beyond its first word. */
function describeTool(name, input = {}) {
  const tool = String(name || "");
  if (/^(Read|NotebookRead)$/.test(tool)) return "Reading " + baseName(input.file_path || input.path);
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return "Writing " + baseName(input.file_path || input.path);
  if (/^(Grep|Glob|LS)$/.test(tool)) return "Searching the project";
  if (tool === "Bash") {
    const first = /^[\s"']*([A-Za-z][\w.-]{0,20})/.exec(String(input.command || ""))?.[1];
    return first ? "Running " + first : "Running a command";
  }
  if (/^Web(Fetch|Search)$/.test(tool)) return "Looking something up";
  if (/^(Task|Agent)$/.test(tool)) return "Working on a part of it";
  if (/^TodoWrite$/.test(tool)) return "Planning the steps";
  if (tool.startsWith("mcp__")) return "Using " + (tool.split("__")[1] || "a connection").replace(/[_-]+/g, " ");
  return tool ? "Using " + tool : "Working";
}

/** Reads one line of Claude Code's event stream. */
function readClaudeEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (!event || typeof event !== "object") return null;
  if (event.type === "result") return { result: typeof event.result === "string" ? event.result : "" };
  if (event.type !== "assistant") return null;
  for (const part of event.message?.content || []) {
    if (part?.type === "tool_use") return { activity: describeTool(part.name, part.input) };
    if (part?.type === "text" && String(part.text || "").trim()) return { activity: "Thinking it through", text: part.text };
  }
  return null;
}

/** For agents with no event stream: their latest plain line is the best picture there is. */
function plainLine(line) {
  const text = String(line || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
  if (!text || text.length < 4 || /^[-=_*#>|\s]+$/.test(text) || /^AIOS-/.test(text) || /^[{[]/.test(text)) return null;
  if (/(api[_-]?key|token|secret|password|bearer)\b/i.test(text)) return null;
  return brief(text.replace(/^\[?\d{4}-\d{2}-\d{2}T[\d:.]+Z?\]?\s*/, ""));
}

function createActivity({ dir, now = Date.now }) {
  const file = path.join(path.resolve(dir), "activity.json");
  let lastWrite = 0;
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  };
  const write = state => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
      fs.renameSync(tmp, file);
    } catch { /* A missed frame is not worth stopping work for. */ }
  };
  return {
    file,
    set(row, agent, text, { force = false } = {}) {
      const words = brief(text);
      if (!words || (!force && now() - lastWrite < WRITE_EVERY_MS)) return;
      lastWrite = now();
      write({ ...read(), [row]: { agent, text: words, at: new Date(now()).toISOString() } });
    },
    clear(row) {
      const state = read();
      if (!(row in state)) return;
      delete state[row];
      write(state);
    },
    all: read,
  };
}

module.exports = { createActivity, describeTool, readClaudeEvent, plainLine };
