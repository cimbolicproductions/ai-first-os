# AGENTS.md — AI-first OS v2 Repository Guide

This repository is **AI-first OS** (`https://github.com/cimbolicproductions/ai-first-os`), a zero-dependency Node.js (`v22+`) chat-first multi-agent operating system and local daemon.

## File Map

### CLI & Scripts
- `bin/aios.cjs` (`bin/fleet.cjs` alias): Unified CLI entrypoint (`desktop`, `daemon`, `chat`, `wake`, `status`, `logs`, `pause`, `resume`, `models`, `phone`, `doctor`, `init`, `autostart`, `keep-alive`).
- `scripts/build-installer.cjs`: Builds self-contained per-platform installers into `dist/`.
- `scripts/preview-server.cjs`: Launches a throwaway preview daemon with mock agents on port 4701.
- `scripts/build-brand.cjs`: Generates `assets/logo-512.png` from pure geometry.

### Core v2 Engine (`lib/v2/`)
- `lib/v2/profile.cjs`: External `~/.aios/profile.json`, multi-root repo discovery (depth 2), fuzzy alias resolution, `critical|standard|sandbox` stakes & merge policies, managed project creation.
- `lib/v2/store.cjs`: Native `node:sqlite` WAL database (`~/.aios/os.db`) owning tasks, chat threads, terminal agent bus logs, provider quotas, model catalog, digest-bound approvals, and crash recovery.
- `lib/v2/worktree.cjs`: Isolated git worktrees (`aios/<taskId>`), upstream freshness checks, full diffs including untracked files, safe commit/merge, and per-project concurrency locks.
- `lib/v2/quota.cjs`: Persisted multi-provider quota & auth-expiry classification (handles timezone-aware clock resets, ISO-8601, relative windows).
- `lib/v2/model-catalog.cjs`: Live model discovery, tier classification (`apex > workhorse > balanced > fast-free`), canary probes, 1-tap promotion cards, cross-provider effort mapping.
- `lib/v2/router.cjs`: Stakes-by-stage auto-router with unlimited provider failover, intelligence floors (no weak/free drop or self-audit on `critical`), and escalation on stalled fix rounds.
- `lib/v2/harnesses.cjs`: Unified 6-CLI runner (`claude`, `codex`, `antigravity`, `gemini`, `opencode`, `cursor`) with non-interactive flags, effort flags, and structured output extraction.
- `lib/v2/agent-bus.cjs`: Per-task run directories (`~/.aios/runs/<taskId>/`), secret-checked cross-repo read-only reference staging, and Obsidian vault delivery sync.
- `lib/v2/pipeline.cjs`: Adaptive 3-stage pipeline (`intake -> planning -> building <-> planner bus -> auditing <-> fix loop -> commit/merge -> Total Output`), continuation matching, and concurrent `tickQueue`.
- `lib/v2/auth-broker.cjs`: Unified 1-link sign-in/OAuth/device-code broker with cached OS keyring storage and automatic task resume.
- `lib/v2/connectors.cjs`: Bidirectional Muse/GrokBot Intake v2, OpenAPI 3.1 spec generator, GrokBot detection, and optional thin Google Sheet sync plugin.
- `lib/v2/transport.cjs`: SSH `.wake` queue watcher, Tailscale/loopback listen config, Bearer token + loopback CSRF protection.
- `lib/v2/daemon.cjs`: Unified HTTP/SSE daemon serving the responsive UI, `/auth` capture page, `/api/v2/*` endpoints, SSE event stream, and phone QR pairing.
- `lib/v2/leak-guard.cjs`: Public-repo privacy & secret hygiene scanner (rejects secrets, Tailscale IPs, personal drive paths, OS usernames, real Sheet IDs, and Supabase project refs).

### Responsive UI (`lib/ui/`)
- `lib/ui/index.html`, `lib/ui/app.css`, `lib/ui/app.js`: Single calm chat-first UI serving both desktop and phone with SSE live updates, pipeline stage chips, digest-bound approval cards, 1-tap auth links, Total Output delivery cards, collapsible Terminal Agent Bus & Git Diff drawers, and System Health modal.

### Shared Infrastructure (`lib/`)
- `lib/harness-registry.cjs`: Process spawning plans (`buildSpawnPlan`), process tree termination (`stopProcessTree`), test guards (`underTest`), binary fallback paths.
- `lib/agent-auth.cjs`: Binary discovery (`locateBinary`) and sign-in detection.
- `lib/no-purchase.cjs`: Purchase-prevention hooks and deny configs for coding agents.
- `lib/keyring.cjs`: Cross-platform OS keyring read/write with in-memory caching and directory secret scanning.
- `lib/activity.cjs`: Stream parsers for Claude Code and Codex activity lines.
- `lib/qr.cjs`: Zero-dependency QR SVG encoder for phone pairing.
- `lib/autostart.cjs`: Cross-platform sign-in autostart and crash-backoff `keepAlive`.
- `lib/relay-core.cjs`, `lib/relay-host.cjs`, `lib/backend-provision.cjs`, `lib/web-push.cjs`, `lib/codex-sheet-transport.cjs`: Optional public cloud relay, push, and sheet transport modules.

## Engineering Rules

1. **Zero runtime npm dependencies.** Use Node 22+ built-ins (`node:sqlite`, `node:http`, `node:crypto`, etc.).
2. **Public repo privacy is mandatory.** Never commit personal paths, usernames, Tailscale IPs, Sheet IDs, business names, or secrets. `lib/v2/leak-guard.cjs` verifies the repo in tests.
3. **Never pass untrusted user/board text on command lines.** Pass prompts via stdin or run-space files (`~/.aios/runs/<taskId>/`).
4. **Tests touch nothing real.** Never launch live AI CLIs, browsers, keyrings, or external network requests during `npm test` (`underTest()` guards enforce this).
5. **No agent purchases anything.** Keep `lib/no-purchase.cjs` enforced across coding harnesses.
6. **Hard gates stay hard.** `critical` repos never self-audit, never silently drop to weak/free tiers, and require explicit digest-bound approval before merging.

## Verification

```bash
npm test
```
