# One thing at a time

A design and build plan for the AI-first OS desktop screen. Plan only: nothing in this file is built yet.
Written 2026-11-15 against `main` at `650d911` (161 tests). For the implementing agent (Codex or Claude Opus) and for the owner to adjust first.

## 1. The idea

**The one human problem.** "I can't tell what is happening or what I am supposed to do." The owner said it three ways in one day: "I just see one little line", "I'm not within one project at a time", "I don't know if it's stuck".

**The promise.** Calm. At any moment the owner knows the one thing in front of them and the one next step.

**The rule.** Hold every decision against these three lines:

1. **One screen is one request.** The request in front of the owner is called the Focus.
2. **One input talks to that request.** Whatever is typed goes to the Focus, never somewhere else.
3. **One button is the next step.** Exactly one primary button at a time, and it says what it will do.

Everything else on the board is **one quiet line** at the bottom. The owner can move to another request once the current one is going, by their own press. The screen never moves on its own.

This follows the product's own principles (`lib/ideology.cjs`): software owns the rules, the screen stays quiet, the human keeps the decisions that matter.

## 2. What is wrong today

Read from `lib/desktop-hud.cjs` at `650d911`:

- **Seven things compete on the home screen:** the ask bar, the composer, the crew row (six dropdowns and two checkboxes), four tabs with counters, the Now card, "N more need you", and the board.
- **An approval can be answered while looking at something else.** `renderAsk` shows the question for the open request, and with none open, "the oldest thing waiting on the owner". So "Approve this external action?" for one request sits above the Now card of a different one. This is a safety problem, not only a visual one.
- **The input always starts a new request.** Typing "continue where you left off with the money making site" created P31 instead of continuing P29. The owner's words had nowhere else to go.
- **The same request shows in three places:** the Now card, a tab list, and the board with its detail pane.

## 3. The design

### 3.1 The Focus

The Focus is one request ID, kept by the app, chosen by the owner.

It changes only when the owner:

- sends a new request (the new request becomes the Focus),
- presses **Go to it** or **Next** on the bottom line,
- picks a request in **Everything**,
- presses **Put away** (the Focus moves to the next request by the rule below),
- presses **New request** (the Focus is cleared and the empty screen shows; `Esc` goes back).

It never changes because an agent finished, a question arrived, or a timer fired.

When there is no saved Focus (first open, or the saved one is gone or put away), `pickFocus` chooses, in order: the request that has waited on the owner longest, then one that is running, then the newest stopped one, then a queued one, then nothing (the empty screen). A finished Focus older than ten minutes is not restored on open.

**Next** always means: the request that has waited on the owner longest.

### 3.2 The screen

```
AI-first OS                                     Stop all   ...

        Project: money site . P30
        Build a money-making website
        Antigravity is working: writing the landing page.
        Last sign of life 12 s ago.

        [ Stop this ]

        [ Add a note for this...                          ]
        What you type here goes to this task only.

--------------------------------------------------------------
While this runs: P31 needs your answer   [Go to it] [New request] [Everything]
```

One column, about 460 px of text, centered, with space above and below. No tabs, no board, no crew row.

### 3.3 The five states

| Focus is | Status line says | Primary button | Second button | The input means |
|---|---|---|---|---|
| nothing | "Say it or type it. Your organizer takes it from there." | Send | none | a new request |
| asking a question | the organizer's question, in full | Send reply | Let it decide | the owner's answer |
| asking for approval | who is asking and the exact action, in full | none: **No** and **Yes, do it** with equal weight | none | hidden. A typed reply never approves |
| working | who, doing what, last sign of life | none | Stop this | a note saved for its next step |
| working but silent 3 min | "has gone quiet for N min. It may be stuck." | Stop and continue with X | none | a note for the next agent |
| stopped or failed | what went wrong, in one sentence | Continue with X | Put away | a note for the next agent |
| queued | "Queued. It starts when an agent is free." | Start now | Put away | a note saved for its first step |
| done | the result, and what follows ("Codex is reviewing it next") | Next | Put away | a note for the next version, or a follow-up |

The words on the Continue button and what it does already exist: `continuePlan` and `continueWords` (`lib/continue-task.cjs`, `lib/desktop-hud.cjs`).

### 3.4 The bottom line

One line, three small buttons at most.

- Something else needs the owner: "P31 needs your answer" (plus "and 2 more"), with **Go to it**.
- The Focus is working: the same line starts "While this runs:". This is the moment the design offers another task.
- Nothing needs the owner: "2 working, 1 queued", or nothing at all.
- **New request** and **Everything** are always there (New request is hidden on the empty screen).

A new question for another request updates this line and fires the existing system notification. It does not open, flash, or take the screen.

### 3.5 Everything

One list of every request, replacing the Coding, Research and Tasks tabs and the board. Groups, in this order: Needs you, Working, Up next, Done, then Put away (collapsed). One filter: project. Picking a row makes it the Focus and closes the list. The row cards and groups already exist (`workCard`, the Coding view in `renderView`).

### 3.6 More

The `...` menu holds what is not about the Focus: Agents, Phone, Who does what (the crew dropdowns and both checkboxes), Today, Sheet tasks, Advanced view. One summary line in Who does what replaces the six dropdowns on the home screen: "Muse organizes. Antigravity codes, then OpenCode. Codex reviews."

**Stop all** stays in the header in every state. It is the one control that must always be one press away.

### 3.7 The cut list

| Today | Becomes |
|---|---|
| Chat, Coding, Research, Tasks tabs | gone. Focus is the home; Everything is the list |
| Show board / Hide board | gone. Everything |
| Crew row on the home screen | More > Who does what |
| Ask bar above the composer | gone. The question is the Focus, or one line at the bottom |
| "Answer Muse" jump button | gone. Go to it |
| Now card | becomes the whole screen |
| Phone and Agents links | More |
| "Enter sends, Shift + Enter adds a line" | placeholder text only |

The advanced view (`state.advanced`) is untouched. It is the power user's door and stays behind More.

### 3.8 Keyboard

`N` new request. `E` Everything. `G` go to the one that needs you. `.` Next. `C` Continue (only when the button shows). `Esc` back. `Ctrl+K` the existing palette, extended to jump to any request by ID or title. No key ever answers an approval: Yes and No are mouse or Tab-then-Space only, and `Enter` in the input never reaches them.

### 3.9 Words

Sentence case. No status jargon: "Needs you", "Working", "Up next", "Done", "Stopped". Say who and what in one sentence. Never show a raw error; show the last plain line and offer Continue. The title is the saved display title; the request's own text is one press away ("Show what I asked").

### 3.10 Look

- One typeface, two weights. Title about 22 px, status 15 px, labels 13 px.
- One accent. Amber only for "stopped" and "may be stuck". No red except Stop all on hover.
- No card borders on the Focus: space is the container. One hairline above the bottom line.
- Moving between requests is a 150 ms crossfade, off under `prefers-reduced-motion`.
- The loading captions and the logo animation stay as they are.

### 3.11 Phone (later phase)

The phone page shows one card at a time, the one that has waited longest, with "1 of 3" and Next. Same rule, smaller screen. It keeps its own answer path.

## 4. Security rules this design must keep

Each rule names where it lives today. A change that breaks one is a bug, whatever it looks like.

| # | Rule | Where |
|---|---|---|
| S1 | Every POST to the desktop server is refused unless it comes from the app's own page. The server listens on 127.0.0.1 only. New routes (`/api/focus`) sit behind the same check | `lib/desktop-hud.cjs` (origin check before the routes); `test/security-boundaries.test.cjs` |
| S2 | Text from requests, agents, Muse, the phone, the Sheet and the naming model is shown with `textContent`. No `innerHTML`. Links only through `safeLink()` | `lib/desktop-hud.cjs` |
| S3 | **An approval is answered only by its own buttons, only while its request is the Focus.** New: the server refuses `/api/answer` for an approval or a choice whose row is not the saved Focus (409, "Open that request first"). Questions with no row (a sign-in, the phone) are exempt. The answer stays tied to the exact question by its digest | new check in `/api/answer`; digest exists in `answerNotice` |
| S4 | Nothing else approves: not Continue (`continuePlan` returns `wait`), not a typed reply, not a note, not Muse (its key reaches two routes), not a key press | `lib/continue-task.cjs`, `lib/request-flow.cjs`, `lib/relay-core.cjs` |
| S5 | An approval card that has just appeared ignores presses for 500 ms, so a click meant for something else cannot land on Yes | new, in the Focus view |
| S6 | Changing the Focus never starts, stops or changes any work. Only named buttons do | new `/api/focus` only writes the Focus |
| S7 | The Focus is stored as one request ID in the board folder. Never in a URL, never sent to the relay | new `board/ui.json` |
| S8 | A note typed into the one input is checked like a phone note: if it orders a send, a publish or a spend it goes to the organizer and its gates, not to a builder | reuse `ordersGatedAction` / `classifyOrganizerRequest` as `takeNote` does in `lib/cloud-link.cjs` |
| S9 | Size limits stay: request 16,000 characters, reply and note 4,000 | `lib/request-flow.cjs` |
| S10 | The agent fences are not part of this work. Do not edit `lib/harness-registry.cjs` or `lib/no-purchase.cjs` for it | tests: `no-purchase`, `no-prompts`, `antigravity` |
| S11 | Tests never start a real agent, touch the real hooks file, or reach the network | `NODE_TEST_CONTEXT` guards |
| S12 | Stop all is reachable in one press from every state | header |

## 5. Security state on 2026-11-15

Fixed the same day, before this plan (`650d911`):

- A background Claude Code run with prompts off could see the owner's connected services (1,170 tools in a live run, among them Gmail send, Vercel buy_domain, Stripe write, Supabase execute_sql). Writing runs now refuse every `mcp__` tool. Checked live.
- Antigravity's hook approved every tool in the app's runs. It now approves only the five a build uses. Checked live.

How each agent is fenced now:

| Agent | Prompts | What holds |
|---|---|---|
| Claude Code | off in writing runs | purchase hook on every command; all connected services refused |
| OpenCode | off (`--auto`) | purchase deny rules |
| Codex | off | commands have no internet; asks Antigravity for web lookups |
| Antigravity | off for five build tools | purchase hook; everything else falls to its own prompts, which a background run cannot answer |

Still open. Check each before calling the system safe; none is part of the screen work:

1. **Codex connected apps.** `codex exec` may reach the owner's connected apps (Drive is used by `lib/codex-sheet-transport.cjs`). Find out whether a writing run can call them without a prompt, and refuse them there if so.
2. **OpenCode and connected tools.** Confirm OpenCode has no MCP servers configured that can send or spend. If its config supports it, deny them in `OPENCODE_CONFIG_CONTENT`.
3. **The purchase list is a list of phrases.** A command that hides the phrase (a script that calls the registrar API, a quoted or split command) is not caught. The real backstops are the owner's rule that the app never buys, and no saved payment method in the agents' reach. Say this plainly in the README rather than imply the list is complete.
4. **Antigravity's hook points at this checkout's path.** If the app folder moves, the hook command fails. Find out whether Antigravity then blocks every tool or lets them through, and make the app repair the entry on start, not only before a run.
5. **Reading runs** use Claude Code's plan mode with the owner's own allow rules. Unchanged today; list which connected tools the owner has allowed.

## 6. Build plan

Work on a branch. Run `npm test` (161 passing, no cancellations) before and after each phase. Each phase is shippable alone.

**Phase 1. The Focus, with no visible change.**
- `lib/focus.cjs` (new): `pickFocus({ tasks, taskMeta, notices, saved, now })` and `nextForOwner(...)`, pure functions. Storage helpers for `board/ui.json` (`{ focus, at }`), written with the temp-file-then-rename pattern the board uses.
- `lib/desktop-hud.cjs`: `GET /api/state` returns `focus`; `POST /api/focus { taskId | null }` validates the ID against the board and saves it.
- Tests (`test/focus.test.cjs`): every rule in 3.1; an unknown ID is refused; cross-origin POST is 403; the file holds only an ID.

**Phase 2. The Focus view.**
- Replace the hero, the Now card and the detail tile (easy mode only) with the screen in 3.2. Reuse `renderNow`, `continueWords`, `continueRow`, the conversation list and the reply form.
- The 4-second refresh must not move the caret, clear typed text, or re-render a card under the pointer. Keep the input node; change only what changed.
- Acceptance: each state in 3.3 renders from a synthetic board; exactly one primary button; text typed in the input survives three refreshes.

**Phase 3. One input.**
- Route by state: `/api/task` (no Focus), `/api/reply` (question), `/api/note` (finished build), `/api/continue { taskId, note }` (stopped), and a saved owner note for working or queued requests (`meta.ownerNotes`, added to the next work order by `buildWorkOrderPrompt`, cleared when used).
- A follow-up on a finished non-build request creates a new request with `followUpOf` and carries the original request and its answer as context.
- Apply S8 and S9 to every path.
- Acceptance: typing "continue the money site" with a stopped request in Focus continues that request and creates no new row.

**Phase 4. The bottom line and Everything.**
- Remove the tabs, the board toggle, the ask bar and the jump button. Add the line (3.4) and the list (3.5).
- Acceptance: a question arriving for another request changes only the line; the Focus and the input do not move.

**Phase 5. Approvals only in Focus.**
- S3 and S5. The approval card shows the request ID, title, project, who is asking and the full action text.
- Acceptance: `/api/answer` for an approval on a non-Focus row returns 409; a press within 500 ms of the card appearing does nothing; `Enter` never answers.

**Phase 6. More.**
- Move Agents, Phone, the crew controls, Today and Sheet tasks into the menu. Add the one-line crew summary.

**Phase 7. Phone.** One card at a time (3.11). Publish to `gh-pages` as before.

Before release: exercise all five states in a browser at 1366 x 768 and 390 x 844 with a synthetic board and a stand-in agent, read the console for errors, and check sizes from the rendered page, not from flags.

## 7. Decisions made for the owner

Change any of these before the build starts.

1. A new question for another request never takes over the screen. It shows on the bottom line and as a notification.
2. When the Focus finishes, the screen stays on it and offers **Next**. No automatic move.
3. Typing while a request is in Focus talks to that request. A new request needs **New request** (or `N`).
4. An approval can only be answered while its request is the Focus.
5. The Coding and Research tabs go away. Everything has the same groups.
6. The crew dropdowns leave the home screen for More.
7. **Next** means the request that has waited on the owner longest.

## 8. Out of scope

- How many agents run at once. This plan is about the owner's attention, not the queue.
- The advanced view, themes, the first-run intro.
- Muse as organizer (the app handing work to Muse).
- Any change to agent launch flags or fences.

## 9. Notes for the implementer

- `lib/desktop-hud.cjs` is one file: the server, and one template string that holds the page's HTML, CSS and script. Inside that string, a regex backslash must be doubled (`\\s`), a backtick is `\\x60`, and `${...}` is filled in by the server.
- The reset has `[hidden] { display: none !important }`. Still judge visibility from computed style or a screenshot, never from `el.hidden`.
- The repo has CRLF line endings. Multi-line search-and-replace scripts miss; make edits one at a time.
- To look at a screen without touching the owner's board: a scratch script that builds a temp board, passes a stand-in `runner` and a `detect` that returns signed-in agents, and listens on a fixed port; add it to `.claude/launch.json`.
- `state.taskMeta[id].next` already tells the page what Continue would do; `taskMeta[id].waitingFor` marks a build waiting on a web lookup.
- Zero runtime dependencies. Node 22. Tests: `node --test --test-concurrency=1`.
