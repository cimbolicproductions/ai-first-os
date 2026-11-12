# AI-first OS

Say what you need. Your AI agents do the work, check each other, and reach you on your phone when they need you.

It works with the ones you already have: Claude Code, Codex, Gemini, Antigravity, Cursor. One is enough.

## Get started

Double-click the installer for your computer. Press Enter three times. Type or say your first request.

From source, with Node 22 or newer and nothing to install:

```bash
node bin/aios.cjs desktop
```

## What happens in the box

**You talk. It organizes.** Type a request or tap **Voice dump** and say everything on your mind. Your organizer turns it into separate tasks on the board and gives each one to the right agent.

**The work gets checked.** When one agent finishes building, another checks it. Anything it finds goes back to be fixed, then gets checked again. If you only have one agent, it checks its own work and says so.

**It keeps going.** If an agent is signed out or at its limit, another one takes the task and the board says who. If nobody can take it right now, it waits a minute and tries again.

**It asks once.** If a task needs a choice or a connection you have not made, it asks in plain words at that moment and remembers.

**Your phone is the front door.** Choose **Use your phone**, sign in, and open your private link. Send requests from anywhere. Questions come back with one-tap answers. The phone shows honestly whether your computer is online, and requests wait for it if it is not.

**Some things always ask first.** Any spending, anything sent to other people, any public submission, and any refund or billing change need your explicit yes, every time.

**Your notes stay yours.** Plain folders and Markdown on your own computer. Nothing uploads them.

## If you want to look behind the box

You never have to. **Advanced mode** shows every task, who has it, and the technical details, and lets you run, audit, or reassign by hand. `node bin/aios.cjs help` lists the terminal commands.

A Google Sheet can be the task list. Today that takes a signed-in Codex with Google Drive connected and one entry in your workspace file: `board.mode` set to `sheets`, and `board.sheets` set to `provider: "codex"` plus your `boardId`.

## For developers

```bash
npm test                            # run the tests
node scripts/build-installer.cjs     # build the installers into dist/
```

To add an agent, add one entry to `lib/harness-registry.cjs`. `AGENTS.md` has the file map.

## License

Licensed under the MIT License. See [LICENSE](LICENSE). Licensing terms apply.
