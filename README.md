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

**It asks before it builds.** If you say "build me a website," it first asks what it is for, who will use it, and what finished looks like. Then it goes to work.

**You pick the crew.** Under the box, choose your organizer, your first and second coding agent, and your first and second research agent. If the first is busy or out, the second takes it.

**It takes the notes.** Each project gets one brief in your vault: the goal, where it lives, what happened, and what is next. Any agent can open it and carry on.

**You can watch it work.** Four tabs: Chat, Coding, Research, and Tasks. While an agent works, one short line says what it is doing right now, like "Reading index.html." Tasks is the plain list of everything open, each with a **Get to work** button.

**It knows your projects.** It finds the project folders on your computer and their GitHub names. Mention one and the work happens there. If it could be more than one, it asks.

**The work gets checked.** When one agent finishes building, another checks it. Anything it finds goes back to be fixed, then gets checked again. If you only have one agent, it checks its own work and says so. Turn **Outside review** off if you do not want it.

**It works in versions.** Version 1 shows up as soon as it is built. While it is being checked, tell it what you want changed. Your notes and the review are combined into one brief, and the same agent builds version 2. Leave **Don’t stop till it’s done** on and it keeps going until the review comes back clean. Turn it off and it shows you each review and waits for your word.

**New ideas get a home.** Ask for something new and it makes a project folder for it, then builds there.

**It can take it to GitHub and the web.** When a version comes back clean it is saved. The first time, it asks whether to keep your projects on your GitHub as private repositories. For each project, it asks before putting it online with Vercel, because anyone with the link can open it. If GitHub or Vercel is not connected, the question has a button that opens the sign-in. It only ever does this for projects it created, never ones you already had.

**It keeps going.** If an agent is signed out or at its limit, another one takes the task and the board says who. If nobody can take it right now, it waits a minute and tries again.

**It uses what you already pay for.** Every run uses your subscription sign-ins. If a pay-per-use key is the only way forward, it asks first, once.

**Your board can be a Google Sheet.** Say "put my board in a Google Sheet." It creates the Sheet in your own Google account and keeps it current: every task, who has it, its status, and the latest note. This uses a signed-in Codex with Google Drive connected.

**It asks once.** If nobody is signed in, the question has a button that opens the sign-in, and the task starts on its own after. If a task needs a choice you have not made, it asks in plain words at that moment and remembers.

**Your phone is the front door.** Choose **Use your phone**, sign in, and open your private link. Send requests from anywhere. Questions come back with one-tap answers. The phone shows honestly whether your computer is online, and requests wait for it if it is not.

**Some things always ask first.** Any spending, anything sent to other people, any public submission, and any refund or billing change need your explicit yes, every time.

**Your notes stay yours.** Plain folders and Markdown on your own computer. Nothing uploads them.

## If you want to look behind the box

You never have to. **Show board** under the box opens the board, and the **Tasks** tab lists everything open. `node bin/aios.cjs help` lists the terminal commands.

## For developers

```bash
npm test                            # run the tests
node scripts/build-installer.cjs     # build the installers into dist/
```

To add an agent, add one entry to `lib/harness-registry.cjs`. `AGENTS.md` has the file map.

## License

Licensed under the MIT License. See [LICENSE](LICENSE). Licensing terms apply.
