# AGENTS.md - AI-first OS Repository Guide

This repository is **AI-first OS** (`https://github.com/cimbolicproductions/ai-first-os`), a zero-dependency Node.js (`v22+`) keyboard-first multi-agent control plane.

## File Map

- `bin/aios.cjs` (`bin/fleet.cjs` alias): CLI entrypoint.
- `lib/harness-registry.cjs`: The open harness list. One entry per agent: finding it, sign-in, running work, models, hotkey.
- `lib/agent-auth.cjs`: Detects harnesses and sign-in state from the registry.
- `lib/roles.cjs`: Default role slate, routing, substitution, audit pairing.
- `lib/os-runtime.cjs`: Work orders, dispatch, report parsing, `answerNotice`, board watcher.
- `lib/notices.cjs`: Every question or update for a person. All surfaces read this one book.
- `lib/audit-loop.cjs`: The Audit action and findings-to-fix-tasks loop.
- `lib/first-run.cjs`, `lib/first-run-page.cjs`: The three-window introduction.
- `lib/desktop-hud.cjs`, `lib/shell-tui.cjs`: Desktop app and terminal shell.
- `lib/relay-core.cjs`: Phone/computer meeting point. Web-standard APIs only, no imports, because it also runs in a Supabase Edge Function.
- `lib/relay-host.cjs`: File store, local server, and the generated Edge Function.
- `lib/cloud-link.cjs`, `lib/home-service.cjs`: Home machine heartbeat, intake, outbox, background service.
- `lib/backend-provision.cjs`: Creates the user's backend behind one sign-in. Stops at any possible cost.
- `lib/autostart.cjs`, `lib/web-push.cjs`, `lib/daily-summary.cjs`, `lib/vault-options.cjs`, `lib/vault-bootstrap.cjs`, `lib/keyring.cjs`, `lib/ideology.cjs`, `lib/workspace.cjs`.
- `adapters/local-board.cjs`, `adapters/sheets-board.cjs`, `adapters/doorbell.cjs`: Boards and the content-free doorbell.
- `phone/`: The static phone page, published from the `gh-pages` branch. Republish that branch when this folder changes.
- `helper/`: The small server function that keeps the Supabase app secret and finishes sign-ins. Deployed separately to Vercel.
- `scripts/build-installer.cjs`: Builds the one-click installers.
- `scripts/build-brand.cjs`: Draws the logo and the loading animation from one set of geometry.
- `product.json`: Product-level switches the owner sets (`phoneAppUrl`, `signInHelperUrl`).
- `os/`: Window tiling and hotkey configs.

## Rules When Building Here

1. **Zero runtime npm dependencies.** Use Node 22+ built-ins.
2. **Never put board or user text on a command line.** Prompts go over stdin or into a work-order file. See `buildSpawnPlan`.
3. **The doorbell stays content-free:** row, event, from, machine, timestamp only.
4. **User-facing words are plain.** No key formats, dashboards, or settings pages. A missing choice becomes a notice, not a failure.
5. **Public repo hygiene.** No secrets, `.env` files, personal IDs, or machine usernames. Test 4 scans the repo.
6. Hard gates stay hard: no spending, external sends, or public submissions without the owner's explicit approval.

## Verification

```bash
node --test test/template.test.cjs
```
