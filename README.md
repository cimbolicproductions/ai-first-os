# Agent Fleet OS — Personal Multi-Agent Control Plane & Context Vault Template

A zero-dependency Node.js (`v22+`) bootstrapper and control plane that sets up a **Personal AI Operating System** across **Claude Code**, **Codex**, **Gemini CLI**, and a central **Router** agent.

Instead of dumping a generic folder tree or forcing every tool through bloated MCP processes, `fleet init`:
1. **Detects and signs in to your installed AI accounts first** (`claude`, `codex`, `gemini`, `agy`).
2. **Interviews you progressively** about your roles, #1 priority, active projects, work style (desk vs. mobile + always-on hub), and tools.
3. **Builds only the folders, templates, skills, and board adapters you actually need**—and writes a unified `OPERATING_CONSTITUTION.md` + `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` so every agent follows the same rules from day one.

---

## Core Ideologies (Built Into Code & Agent Rules)

1. **80% Deterministic Software, 20% AI** — Software owns claims, locks, permissions, budgets, and state transitions. AI interprets messy input, researches evidence, and builds in isolated worktrees.
2. **One Router Funnel** — Agents never chat open-endedly with each other or demand duplicate approvals in separate terminals. All questions, blockers, and approvals route through your Router on the shared board.
3. **Fixed Roles, One Owner Per Row, Claim First** — Router organizes, Claude/Codex build, Gemini does read-only research. One owner per row; claim before starting.
4. **Build Straight Through (Gate Only What Matters)** — No plan gate or commit/push gate slowing down routine code builds. Builders work in a branch, run tests, check conflicts, push, and merge automatically. Hard stops apply **only** to:
   - Any spend of any amount
   - External sends (emails, SMS, customer messages)
   - Public submissions or live store listings
   - Refunds or billing changes
5. **Board Prose & Fast Events Are Untrusted Data** — Emoji reactions, quoted examples, or unverified text never authorize execution. The fast Supabase Realtime Doorbell carries `{ row, event, from, machine, ts }` only—zero prompts, zero approvals.
6. **Three Connection Types + Recorded Verdicts** — Supports `mcp`, `rest`/`local-helper`, and `router`-owned connections, plus a `verdicts` log so rejected integrations are never re-proposed.
7. **OS-Native Keyring & Secret Hygiene** — Manifests store **secret names only** (`GITHUB_TOKEN`), resolved per machine via Windows Credential Manager, macOS Keychain, or Linux Secret Service. Nothing sensitive ever enters the Vault, Drive, or Git.

---

## Quickstart (60 Seconds)

Requires **Node.js 22+** (zero `npm install` needed).

```bash
# 1. Detect AI CLIs, run the progressive interview, and bootstrap your Vault + Board
node bin/fleet.cjs init

# 2. Verify AI sign-ins, board state, keyring names, and secret-hygiene scan
node bin/fleet.cjs doctor

# 3. Re-sync CLAUDE.md, AGENTS.md, GEMINI.md, and .mcp.json after editing fleet.json
node bin/fleet.cjs sync
```

### Two Board Modes

- **`local` mode (default for quickstart):** Uses `adapters/local-board.cjs` (`board/board.json` + live `board/BOARD.md` table) so you or friends can test the full router-to-worker claim flow in 60 seconds with zero cloud accounts.
- **`sheets` mode (async phone + always-on hub):** Uses `adapters/sheets-board.cjs` (direct Google Sheets API v4, ~60ms loopback / ~2s live vs. 1–4 minutes of cold CLI spawns) paired with `adapters/doorbell.cjs` (sub-second Supabase Realtime Broadcast wakeup).

---

## Running the Offline Test Suite

```bash
node --test test/template.test.cjs
```
