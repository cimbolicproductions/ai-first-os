# AI-first OS

One board for all your AI agents. Claude Code, Codex, Gemini, Antigravity and Cursor work from the same list, check each other's work, and reach you on your phone when they need you.

## Get started

Double-click the installer for your computer. It sets itself up, including its own runtime if you need one.

Three windows follow, once: a welcome, who should run the show, and the rest of your sign-ins. Everything is already filled in. You land in Easy mode with a place to type and a board that shows what is happening.

From source, with Node 22 or newer and nothing to install:

```bash
node bin/aios.cjs desktop
```

## How it works

**Start with a request.** Type a question or press `Space` to focus the request box. Send it and follow the reply and progress on the board. Select a queued task and press `R` or click Run to start it now. Use Advanced mode to choose an agent yourself or inspect the technical details.

**Your organizer coordinates.** A question about open tasks reads the connected board. Questions and planning use an organizer flow. Research and code changes go to the appropriate worker. The board names the worker that actually ran. Muse is an organizer identity and can use an available local agent for requests that need a model.

**Audit.** When a build lands, you get one button. The other agent reviews the work, and anything it finds goes back to the builder as fix tasks. Nobody relays anything.

**Asked once.** If something needs a choice you have not made, it asks in plain words at that moment and remembers.

**Your phone.** Choose **Use your phone**, select **Connect my phone**, sign in, and open the private link on your phone. Send requests from that link. Blocked work comes back in plain words with one-tap yes or no. The phone shows honestly whether your computer is online, and requests wait for it if it is not.

**Your notes stay yours.** The vault is plain folders and Markdown on your own computer, or an Obsidian vault if you prefer. Nothing uploads it. One skills folder serves every agent.

**Some things always ask first.** Any spending, anything sent to other people, any public submission, and any refund or billing change need your explicit yes, every time.

## Keys

| Key | Does |
| --- | --- |
| `1`-`6` | Board, Claude, Codex, Gemini, Antigravity, Cursor |
| `Space` | New task |
| `r` | Run the selected task |
| `a` | Audit it |
| `d` | What your agents did today |
| `o` | Who does what |
| `v` | Say a task |

Easy mode shows the shortcuts for sending and running a request. The full keyboard controls are available in Advanced mode and the terminal shell (`node bin/aios.cjs`). Run `node bin/aios.cjs help` for the commands.

## For developers

```bash
npm test                            # run the tests
node scripts/build-installer.cjs     # build the installers into dist/
```

To add a harness, add one entry to `lib/harness-registry.cjs`.

## License

Licensed under the MIT License. See [LICENSE](LICENSE). Licensing terms apply.
