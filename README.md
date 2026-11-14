# AI-first OS

Say what you need. Your AI agents do the work, check each other, and reach you on your phone when they need you.

It works with the ones you already have: Claude Code, Codex, Antigravity, Cursor. One is enough. Have none? It can add a free one that needs no account.

## Get started

Double-click the installer for your computer. Press Enter three times. Type or say your first request.

From source, with Node 22 or newer and nothing to install:

```bash
node bin/aios.cjs desktop
```

## What happens in the box

**You talk. It organizes.** Type a request or tap **Voice dump** and say everything on your mind. Your organizer turns it into separate tasks on the board and gives each one to the right agent.

**It asks before it builds.** If you say "build me a website," it first asks what it is for, who will use it, and what finished looks like. It keeps asking, a few short questions at a time, until it has a clear picture of the best version of what you want. Say "go ahead" or "you decide" at any point and it stops asking, makes the remaining choices itself, and writes them down where you can see them.

**You pick the crew.** Under the box, choose your organizer, your first and second coding agent, and your first and second research agent. If the first is busy or out, the second takes it.

**It takes the notes.** Each project gets one brief in your vault: the goal, where it lives, what happened, and what is next. Any agent can open it and carry on.

**You can watch it work.** Four tabs: Chat, Coding, Research, and Tasks. While an agent works, one short line says what it is doing right now, like "Reading index.html." Tasks is the plain list of everything open, each with a **Get to work** button.

**It knows your projects.** It finds the project folders on your computer and their GitHub names. Mention one and the work happens there. If it could be more than one, it asks.

**The work gets checked.** When one agent finishes building, another checks it. Anything it finds goes back to be fixed, then gets checked again. If you only have one agent, it checks its own work and says so. Turn **Outside review** off if you do not want it.

**It works in versions.** Version 1 shows up as soon as it is built. While it is being checked, tell it what you want changed. Your notes and the review are combined into one brief, and the same agent builds version 2. Leave **Don’t stop till it’s done** on and it keeps going until the review comes back clean. Turn it off and it shows you each review and waits for your word.

**New ideas get a home.** Ask for something new and it makes a project folder for it, then builds there. Name several new things in one breath and each gets its own folder.

**There is a free agent.** OpenCode runs free models, DeepSeek first, with no account and no key. It shows in the list like any other agent. If it is missing, or too old to work, one press on **Add** or **Update** gets it. Free models can be slower and have daily limits, and they run on someone else's computers, so do not give them secrets. It only ever picks a free model, and skips the ones whose makers say they may learn from what is sent.

**It can take it to GitHub and the web.** When a version comes back clean it is saved. The first time, it asks whether to keep your projects on your GitHub as private repositories. For each project, it asks before putting it online with Vercel, because anyone with the link can open it. If GitHub or Vercel is not connected, one tap starts the sign-in: the approval page opens, the same link shows on your phone, and the work carries on by itself once you approve. It only ever does this for projects it created, never ones you already had.

**It can give a project its own address.** After a project first goes online, it offers once to find it a web address. It checks which names close to the project's name are free (with first-year prices if Namecheap is connected) and lists up to three. Pick one and Namecheap's own checkout opens, on your computer or your phone. You pay there; the app never buys anything. Once the name is yours it notices on its own and asks for one more step while you are still in Namecheap: a button straight to that name's page (it also opens on your computer), the two nameservers to copy, and Done. No agent clicks anything in an account that holds your card. When you choose Done, the app checks the public registry record itself, and only then attaches the name in Vercel and calls it set up. If Namecheap's API is connected, there is no step at all: the app sets the nameservers through the API. If you would rather an agent did it, choose "Have Claude Code do it" on that card, for that one time. Namecheap has no sign-in button for apps, so connecting its API means pasting your username and API key once on your computer, and allowing your computer's address, which the app shows you. The key is kept in your computer's keyring. Namecheap only turns API access on for accounts with 20 or more domains, a $50 balance, or $50 spent in the last two years.

**It keeps going.** If an agent is signed out or at its limit, another one takes the task and the board says who. If nobody can take it right now, it waits a minute and tries again. If your account cannot use the model an agent is set to, it switches to one that works.

**It gets missing tools itself.** If the sign-in tool a service needs is not on your computer, the question has an **Add** button. It is fetched, the sign-in starts, and the waiting work carries on.

**It uses what you already pay for.** Every run uses your subscription sign-ins. If a pay-per-use key is the only way forward, it asks first, once.

**Your board can be a Google Sheet.** Say "put my board in a Google Sheet." It creates the Sheet in your own Google account and keeps it current: every task, who has it, its status, and the latest note. A line you type at the bottom of the Sheet becomes a request, a Status you set to Done or Open is applied, and a note you write on a finished build goes into its next version. This uses a signed-in Codex with Google Drive connected.

**It asks once.** If nobody is signed in, the question has a button that opens the sign-in, and the task starts on its own after. If a task needs a choice you have not made, it asks in plain words at that moment and remembers.

**You can ask for an address any time.** Say "give the bakery site its own address" in the chat and the same step starts for that project.

**Agents can work in your own Chrome, if you ask.** When you choose "Have Claude Code do it", pointing a name you bought at your site is done in your own Chrome, where you are already signed in, so no password passes through this app. Claude Code does it inside a fence: this app checks every browser step before it runs. The agent works in one tab that it opens itself and cannot touch any other, and that tab can only go to that one domain's page. If the page sends it somewhere else, such as a sign-in page, it can only look and close the tab. On the domain's page it makes one change at a time, each only after reading the page again: a click on something the page labels as being about nameservers, or filling a nameserver box with one of the two nameservers. No keys, no typing, no clicking by position. Renew, Auto-Renew, add-ons, every Buy button, and anything near a price are out of its reach. If Namecheap needs you to sign in, or Chrome needs the Claude extension, the question takes you straight to that page. Codex does not do this job: its browser steps cannot be checked one by one, so nothing would stand between it and a purchase but its instructions. The public record decides whether it worked, never the agent.

**Your phone is the front door.** When something is waiting on you, the question has **Answer from your phone**. Tap it, sign in once, and point your phone's camera at the code that appears. You can also open it any time from **Phone**. Send requests from anywhere. Questions come back with one-tap answers. The phone shows honestly whether your computer is online, and requests wait for it if it is not.

**Notes work from your phone.** An update about a finished build has **Add a note**. What you write goes into the next version, the same as a note typed on the computer.

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
