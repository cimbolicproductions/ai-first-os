# AI-first OS

Talk to one calm operating system from your phone or desktop. It clarifies your idea, routes each stage to the right terminal agent and model effort, coordinates agents over a local file-backed bus, cross-checks every build with a second model, fails over automatically when any subscription hits a quota wall, and delivers one Total Output card.

Zero runtime dependencies. Requires Node.js 22+ (uses native `node:sqlite`).

## Quick Start

```bash
node bin/aios.cjs desktop
```

Or run headless as a background daemon (ideal over Tailscale/SSH):

```bash
node bin/aios.cjs daemon
```

## Architecture

- **Single Source of Truth (`~/.aios/os.db`)**: Local SQLite WAL database tracks tasks, chat threads, terminal agent bus exchanges, persisted provider quota reset clocks, discovered models, and digest-bound approvals.
- **External Private Profile (`~/.aios/profile.json`)**: Your project roots, repo stakes (`critical`, `standard`, `sandbox`), Obsidian vault path, Tailscale address, and connector toggles live outside any repository.
- **Unified Terminal Agent Runtime**: Orchestrates all 6 CLI harnesses (`claude`, `codex`, `antigravity`, `gemini`, `opencode`, `cursor`) over isolated git worktrees (`aios/<taskId>`) with per-project concurrency locks and real git diffs.
- **Stakes-Aware Auto-Routing & Failover**:
  - `critical`: Flagship workhorse planner -> workhorse builder -> mandatory **distinct** cross-model auditor -> 1-tap merge approval.
  - `standard`: Workhorse planner -> balanced builder executing `plan.md` -> distinct workhorse auditor (escalates if fixes stall).
  - `sandbox`: Fast planner -> fast/cheap/free builder -> auto-merge on green tests + clean audit.
  - Automatic failover across subscriptions when usage resets or auth expires, with real clock-based cooldown persistence.
  - Live model discovery with read-only canary checks and 1-tap promotion cards.
- **Terminal Agent Bus**: Agents collaborate through structured JSON artifacts (`brief.md`, `plan.md`, `build-result.json`, `audit-result.json`, `bus/*.json`) inside `~/.aios/runs/<taskId>/` — including builder-to-planner clarification and auditor-to-builder fix loops.
- **Unified 1-Link Sign-In Broker**: When any CLI or external service (GitHub, Vercel, Stripe, Supabase, etc.) needs authentication, the OS pauses the task, sends a single secure sign-in card to desktop and phone, stores credentials in the OS keyring, and resumes automatically.
- **Bidirectional Connectors**: OpenAPI 3.1 intake for Muse, local GrokBot detection, SSH `.wake` queue watching, and optional Google Sheet status sync.
- **One Responsive UI**: One clean chat-first surface served directly by the local daemon for both desktop and mobile (over Tailscale or LAN), with collapsible Terminal Agent Bus and Git Diff drawers.

## CLI Commands

```bash
aios desktop                 # Start unified daemon and open app window
aios daemon                  # Run unified daemon headless
aios chat "<text>"           # Submit a request or reply to a task
aios wake <text|taskId>      # Enqueue a task or resume an existing one
aios status [--json]         # Queue status, active tasks, CLIs, and quotas
aios logs <taskId>           # Thread, agent bus messages, and Total Output
aios pause | resume          # Pause or resume automatic execution
aios models [--refresh]      # List models or run live canary discovery
aios phone                   # Show direct phone pairing URL
aios doctor                  # Verify Node 22+, SQLite, git, CLIs, and hygiene
aios init [options]          # Initialize or update ~/.aios/profile.json
aios autostart on|off|status # Manage sign-in autostart
```

## Development & Verification

```bash
npm test                     # Run the full automated test suite
npm run build:installer      # Build self-contained OS installers into dist/
```

See [AGENTS.md](AGENTS.md) for the repository file map and engineering rules.

## License

MIT — see [LICENSE](LICENSE).
