# AI-first OS

A zero-dependency Node.js (`v22+`) **AI-first native operating system** that connects your AI services (**Claude Code**, **Codex**, **Gemini CLI**, **Antigravity**), your external tools/APIs, and your personal **Context Vault** around a single **Task Board**.

Instead of forcing every workflow through heavy frameworks or hardcoded folders, `node bin/aios.cjs init`:
1. **Signs in to the AI accounts you actually have** (`claude`, `codex`, `gemini`, `agy`).
2. **Asks progressive questions to figure out what you need** (projects, research, operations, or a minimal workspace).
3. **Wires your Task Board + AI services + external connections together** so you can queue tasks on the board and have the OS automatically wake the right AI service, execute the work, update the board, and hand results back in real time.

---

## Quickstart (60 Seconds)

Requires **Node.js 22+** (zero `npm install` needed).

```bash
# 1. Detect/sign in to your AI services, answer the setup questions, and initialize your OS
node bin/aios.cjs init

# 2. View your live Task Board
node bin/aios.cjs board

# 3. Queue a new task onto the Task Board for any connected AI service
node bin/aios.cjs task "Audit auth flow and add unit tests" --to claude

# 4. Claim & run the next Open task on the Task Board (or watch the board continuously)
node bin/aios.cjs run
node bin/aios.cjs watch

# 5. Verify AI sign-ins, board state, keyring names, and secret hygiene
node bin/aios.cjs doctor
```

---

## How AI-first OS Works

1. **Task Board at the Center (`local` or `sheets` + `doorbell`):**
   - **`local` mode (default):** Instant JSON + Markdown task board (`board/board.json` & `board/BOARD.md`) watched via `fs.watch`.
   - **`sheets` mode (cloud + mobile + always-on hub):** Direct Google Sheets API v4 adapter (`adapters/sheets-board.cjs`, ~60ms loopback / ~2s live) paired with a content-free Supabase Realtime WebSocket Doorbell (`adapters/doorbell.cjs`) for sub-second wakeups across machines.
2. **One Organizer/Router, Fixed Roles, One Owner Per Row:**
   - Your **Router** agent organizes and routes approvals; **Builders** (`claude`, `codex`) execute code in isolated branches/worktrees; **Researchers** (`gemini`) run read-only synthesis. Every task row is claimed (`[RUN <id> <runId> <claimCode>]`) before execution and written by column name, never position.
3. **Build Straight Through (Pause Only on Hard Gates):**
   - No plan gate or commit/push gate for routine builds. Hard stops apply **only** to:
     - Any spend of any amount
     - External sends (emails, SMS, outreach)
     - Public submissions or live store listings
     - Refunds or billing changes
4. **Pluggable Connections (`mcp`, `rest`, `router`) + OS Keyring:**
   - Connect MCP servers, lightweight REST helpers, or router-managed tools in `aios.yaml`. Manifests store **secret names only** (`GITHUB_TOKEN`), resolved per machine via native OS keyrings.

---

## Running the Test Suite

```bash
node --test test/template.test.cjs
```
