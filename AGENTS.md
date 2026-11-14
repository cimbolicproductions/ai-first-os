# AGENTS.md - AI-first OS Repository Guide

This repository is **AI-first OS** (`https://github.com/cimbolicproductions/ai-first-os`), a zero-dependency Node.js (`v22+`) keyboard-first multi-agent control plane.

## File Map

- `bin/aios.cjs` (`bin/fleet.cjs` alias): CLI entrypoint.
- `lib/harness-registry.cjs`: The open harness list. One entry per agent: finding it, sign-in, running work, models, hotkey, and optionally `browser` (can work in the owner's own Chrome), `free` (no account needed), `install` (how the app adds it), `run.stream` (a live step stream) and `run.fallbackModels`. OpenCode is the free agent: it runs free models, DeepSeek first, picked from its own list.
- `lib/browser-guard.cjs`: The fence around a browser job. Claude Code runs it as a hook before and after every browser step; a step outside "set two nameservers for one domain" is refused by this program (exit code 2): the job works in the one tab it opens, that tab may only be sent to that domain's control panel page (compared after parsing), and where the tab really is comes from the "Tab Context" Chrome reports after every step; once the tab is anywhere but the domain's page (Namecheap's login page, for a signed-out browser) it may only look and close. Only two kinds of change exist: a plain left click by ref, and form_input with one of the two nameservers or Custom DNS. No keys, no typing, no double clicks, no positions, no modifiers. A change needs Chrome's report that the tab is on the domain's page, and a reading (read_page or find) taken there after the last change finished; the change uses that reading up. One change in flight at a time, and no change while a reading is in flight, so batched steps cannot slip past each other. An element qualifies if its own label names nameservers or Custom DNS, or it is a plain Save or Add button whose surroundings (find's "in" text) are the Nameservers section; money, renewal, ordering, confirming, add-ons, privacy, email, transfer and account words in the label or surroundings rule it out, as do toggles and links that leave the page. The job's own tab on a cart or payment address stops the job. Anything it cannot read is refused. A look-only mode (`guardSettings({ lookOnly: true })`) allows reading and closing only. Checked live in real Chrome on 2026-11-13. Only agents with `browser.guarded === true` (Claude Code) are offered or run for a browser job at all; Codex's browser tool runs its own scripts, so it is not used.
- `lib/install.cjs`: Adds or updates a listed tool (an agent, or a service's sign-in tool) on the owner's press. Fixed package names only.
- `lib/agent-auth.cjs`: Detects harnesses and sign-in state from the registry.
- `lib/roles.cjs`: Default role slate, routing, substitution, audit pairing.
- `lib/os-runtime.cjs`: Work orders, dispatch, report parsing, `answerNotice`, board watcher.
- `lib/notices.cjs`: Every question or update for a person. All surfaces read this one book. A notice may carry `copy` (up to four short values shown as copy buttons) and `back: true` (the end of something the owner was waiting on, such as a sign-in or an install: the desktop page shows one system notification that brings them back to the chat when they are in another window, and the phone is rung). An agent's own sign-in window is watched by `watchSignIn` in `lib/os-runtime.cjs`, so the waiting task starts the moment it finishes.
- `lib/audit-loop.cjs`: The Audit action and findings-to-fix-tasks loop.
- `lib/versions.cjs`: Versions of a build. Owner notes and review findings are combined into one brief for the next version.
- `lib/connect.cjs`: Service sign-ins run in the background; the approval link shows in the app and on the phone, and waiting work resumes when approved.
- `lib/ship.cjs`: New project folders, saving a version, the private GitHub repository and the Vercel address (production deploys). Only for projects the OS created. Asks before anything leaves the computer.
- `lib/domains.cjs`: A project's own web address. Finds free names (Namecheap API with prices when connected, the public RDAP registry record otherwise), opens Namecheap's checkout, watches for the purchase, then sets Vercel's nameservers: Namecheap's API when connected; otherwise, by default, the one-link step (`handOff`): a card with a button straight to that name's control panel page, also opened on the computer, the two nameservers as copy buttons (`copy` on a notice, shown on the computer and the phone), and Done, which the RDAP record checks before `attachToVercel`. An agent in the owner's signed-in Chrome (only fenced ones, `browser.guarded === true`) runs only when the owner chooses "Have ... do it" on that card, or sets `settings.domains.agentPoints` to "yes". No agent clicks anything in Namecheap by default. Success is decided by the RDAP registry record, never the agent's report. Never buys anything. The Namecheap key goes only to the keyring and only in request bodies. Browser jobs refuse to start under the test runner (`NODE_TEST_CONTEXT`).
- `lib/qr.cjs`: Zero-dependency QR encoder (byte mode, level M, versions 1 to 40) for the phone link.
- `lib/sheet-board.cjs`: Creates the owner's board Sheet and mirrors the local board into it. The local board stays the engine. Once a minute it reads the Sheet back: a line typed at the bottom becomes a request, a Status set to Done or Open is applied, and a note on a finished build goes into its next version. The board wins whenever it has moved on.
- `lib/activity.cjs`: The short live line of what each working agent is doing. Kept beside the board, never in it. Reads Claude Code's and Codex's step streams; other agents show their latest plain line.
- `lib/project-brief.cjs`: One brief per project in the vault, written by the software as work lands.
- `lib/projects.cjs`: Finds the owner's project folders and GitHub names so work runs in the right place without asking.
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
7. **A test reaches nothing real.** Agent runs, sign-ins, installs, GitHub, Vercel, the keyring, the network and browser jobs all refuse to start under the test runner (`underTest()` in `lib/harness-registry.cjs`) unless the test passes its own stand-in. A new side effect gets the same guard.
8. **Building needs a project folder.** Work the organizer sends to a builder always names a project, or a new one that `createProject` really started (git said so and `.git/HEAD` exists). With neither, the organizer asks which project; a builder never runs in this app's own folder.
9. **Never take an agent's word for what a check can confirm.** The registry record decides a nameserver change; GitHub decides whether a repository is private before every push.

## Verification

```bash
npm test
```
