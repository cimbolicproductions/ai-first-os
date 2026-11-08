# AGENTS.md - AI-first OS Repository Guide (Codex / Builders)

This repository is **AI-first OS** (`https://github.com/cimbolicproductions/ai-first-os`), a zero-dependency Node.js (`v22+`) Omarchy-style keyboard-first AI operating system.

## Architecture & File Map

- `bin/aios.cjs` (`bin/fleet.cjs` alias): Main CLI entrypoint (`tui`, `desktop`, `init`, `connect`, `share`, `voice`, `board`, `task`, `run`, `watch`, `sync`, `doctor`).
- `lib/omarchy-tui.cjs`: Full-screen ANSI tiling terminal workspace (`[1:Board] [2:Claude] [3:Codex] [4:Gemini] [5:Antigravity]`, Command Palette, Service Dropdown, Share modal, Voice trigger, Omarchy themes).
- `lib/omarchy-desktop.cjs`: Frameless Desktop HUD HTTP server + `--app` window launcher + Web Speech / OS voice + live task board controls.
- `lib/os-runtime.cjs`: Task Board work-order builder (`buildWorkOrderPrompt`), single-owner row claim & CLI dispatcher (`dispatchBoardTask`), and continuous board watcher (`watchTaskBoard`).
- `lib/service-catalog.cjs`: Plug-and-play dropdown catalog (`SERVICE_DROPDOWN_CATALOG`) and Omarchy color themes (`OMARCHY_THEMES`).
- `lib/voice-and-share.cjs`: Native OS voice-to-text (`captureVoiceNative`, `saveVoiceDumpToInbox`) and 1-keystroke handoff (`shareToTarget`) to Antigravity, Claude Code, Codex, Gemini, or the Task Board.
- `lib/agent-auth.cjs`: Auto-detects `claude`, `codex`, `gemini`, and `antigravity` (`Antigravity.exe` / `antigravity-ide` / `agy`) across `PATH` and standard OS install paths.
- `lib/ideology.cjs` & `lib/vault-bootstrap.cjs`: Generates the progressive `ContextVault/`, `OPERATING_CONSTITUTION.md`, and workspace agent instruction files.
- `lib/keyring.cjs`: Cross-platform OS keyring secret-name validator and repository secret-hygiene scanner.
- `adapters/local-board.cjs`: Atomic JSON + Markdown Task Board (`board/board.json` + `board/BOARD.md`), write-by-column-name, claim-first protocol.
- `adapters/sheets-board.cjs` & `adapters/doorbell.cjs`: Parameterized Google Sheets API v4 board adapter and content-free Supabase Realtime Broadcast WebSocket doorbell.
- `os/`: Window tiling & global hotkey configs for Linux/Omarchy (`os/linux/hyprland-aios.conf`), Windows (`os/windows/glazewm-aios.yaml`), and macOS (`os/macos/skhdrc-aios`).

## Rules When Building in This Repo

1. **Zero external npm dependencies** in runtime modules (use Node `v22+` built-ins: `node:fs`, `node:http`, `node:crypto`, `node:child_process`, `node:test`, global `fetch`, global `WebSocket`).
2. **Build straight through:** Work in a branch/worktree, run `node --test test/template.test.cjs`, and keep all 5 test suites green.
3. **Public template hygiene:** Never commit secrets, `.env` files, personal spreadsheet IDs, or machine-specific usernames. Test suite #4 scans the entire repo automatically.

## Verification Command

```bash
node --test test/template.test.cjs
```
