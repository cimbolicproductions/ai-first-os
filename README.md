# AI-first OS (Omarchy-Style Keyboard-First AI Environment)

A zero-dependency Node.js (`v22+`) **Omarchy-inspired AI-first operating environment** that connects your AI services (**Claude Code**, **Codex**, **Gemini CLI**, **Antigravity**), your external tools/APIs, and your **Context Vault** around a live **Task Board** with zero mouse clicking.

---

## What Makes It Run Like Omarchy

1. **Keyboard-First Tiling Shell (`node bin/aios.cjs` TUI & `node bin/aios.cjs desktop` Frameless HUD):**
   - **Waybar-Style Top Bar:** Shows live workspaces (`[1:Board] [2:Claude] [3:Codex] [4:Gemini] [5:Antigravity]`), Router status, connected services, and voice readiness.
   - **1-Keystroke Agent Toggling (`1`–`5`):** Jump between the Shared Task Board, Claude Code, Codex, Gemini Research, and Antigravity without touching the mouse.
   - **Omarchy Command Palette (`Space` or `Ctrl+K`):** Fuzzy launcher to queue tasks, run board rows, switch themes, or trigger actions in 1 keystroke.
   - **Plug-and-Play Service Dropdown (`c`):** Select any service (`GitHub`, `Google Sheets Board`, `Supabase Realtime Doorbell`, `Obsidian Vault`, `Vapi REST`, `Stripe Router`, `Search Console`) from a dropdown. It initializes the config in `aios.yaml` and stores secret names in your native OS keyring.
   - **1-Keystroke Easy Share (`s`):** Pipe the selected Task Board row, clipboard, or file straight to **Antigravity (`agy`)**, **Claude Code (`claude`)**, **Codex (`codex`)**, **Gemini (`gemini`)**, or the **Task Board**.
   - **Native Voice-to-Text (`v`):** Press `v` to speak a task or brain dump using native OS speech recognition (Windows `System.Speech`, Browser Web Speech API in Desktop HUD, or macOS/Linux mic helper) and route it straight to `00_Inbox/Brain_Dumps` and onto the Task Board.
   - **Built-in Omarchy Themes (`t`):** Cycle cleanly between **Tokyo Night**, **Catppuccin Mocha**, **Gruvbox Dark**, **Kanagawa Wave**, and **Everforest Dark**.
2. **OS-Level Window Tiling & Global Hotkeys (`os/`):**
   - **Linux / Omarchy (`os/linux/hyprland-aios.conf`):** Native Hyprland keybindings (`Super+Space`, `Super+1..5`, `Super+V`, `Super+S`).
   - **Windows (`os/windows/glazewm-aios.yaml`):** GlazeWM tiling workspaces + `Alt+Space` / `Alt+1..5` / `Alt+V` / `Alt+S` global hotkeys.
   - **macOS Hub (`os/macos/skhdrc-aios`):** Aerospace / `skhd` bindings for an always-on MacBook hub.

---

## Quickstart (60 Seconds)

Requires **Node.js 22+** (zero `npm install` needed).

```bash
# Launch the full-screen Omarchy TUI (runs progressive AI sign-in & setup on first run)
node bin/aios.cjs

# Or launch the frameless Omarchy Desktop HUD window (--app mode)
node bin/aios.cjs desktop
```

### Direct Keyboard & CLI Commands

```bash
node bin/aios.cjs init                              # Sign in to AI accounts & run setup interview
node bin/aios.cjs connect                           # List or connect services from the dropdown catalog
node bin/aios.cjs share "Fix auth bug" --to agy     # 1-step share to Antigravity / Claude / Codex / Gemini
node bin/aios.cjs voice                             # Capture native voice-to-text into Vault + Task Board
node bin/aios.cjs board                             # View live Task Board rows
node bin/aios.cjs task "Add tests" --to claude      # Queue a task on the Task Board
node bin/aios.cjs run                               # Claim & run the next Open task on the board
node bin/aios.cjs watch                             # Watch Task Board in real time & wake assigned AI services
node bin/aios.cjs doctor                            # Verify AI sign-ins, board state, keyring, and secret hygiene
```

---

## Core Operating Rules (Built Into Every Agent)

1. **80% Deterministic Software, 20% AI** - Software owns claims, locks, permissions, budgets, and state transitions. AI researches and builds in isolated worktrees.
2. **One Router Funnel** - All questions, blockers, and approvals route through your Router on the shared Task Board.
3. **Fixed Roles, One Owner Per Row, Claim First** - Router organizes, Claude/Codex build, Gemini does read-only research. Every row is claimed (`[RUN <id> <runId> <claimCode>]`) before work begins.
4. **Build Straight Through (Gate Only What Matters)** - No plan gate or commit/push gate for routine builds. Hard stops apply **only** to:
   - Any spend of any amount
   - External sends (emails, SMS, customer outreach)
   - Public submissions or live store listings
   - Refunds or billing changes

---

## Running the Test Suite

```bash
node --test test/template.test.cjs
```
