# Path of Dust — Desktop

An unofficial desktop companion for **Path of Dust**, the interactive Twitch RPG played on
[**Lokati_Gaming**](https://www.twitch.tv/lokati_gaming). It puts the live game overlay, your
character sheet, and the full bag / crafting / passives dashboard into one app — so you can manage
your character and watch the action without juggling browser tabs.

> A community companion app, built and released **with Lokati_Gaming's approval** — but not the
> official app, and not authored by Lokati_Gaming. It uses your own Twitch login to show and
> manage *your* character, exactly as the website does.

---

## What it does

- **Live overlay** — the real game view, embedded. Scroll to zoom, double-click to reset. A
  **✨ Highlight me** toggle dims the other players so your character stands out.
- **Character stats** — a draggable, collapsible panel that stays over the overlay and refreshes
  live (the instant a fight resolves, not on a timer).
- **Bag & Crafting** — your whole inventory: equip/unequip, disenchant, lock, **Disenchant All**,
  and every craft (Transmute, Scour, Augment, Regal, Exalt, Krangle, Polish, Reforge, Recombine)
  with **live, correct costs**. Veiled/token crafts show the **“choose your outcome”** picker.
  Sort and group your bag (and it remembers how you like it).
- **Roll tiers** — every modifier shows a **T1–T8** badge and its roll %, gold for top rolls.
- **Passives** — the full skill tree, laid out like the site, allocate/respec in place.
- **Twitch chat** — the channel chat in a movable panel, **already logged in**, with your **7TV**
  emotes if you have the extension installed.
- **Notifications** — a toast when a new item drops (with quick Disenchant / Lock / Bag), and a
  top-of-the-hour reminder when the **Reforge Gear** channel reward is available.
- **Share gear** — one click copies a clean, chat-ready line for any item.

---

## Install

1. Download the installer: [**PathOfDust-Setup.exe**](https://github.com/micaelmbsilva/PathOfDust_Desktop/releases/latest/download/PathOfDust-Setup.exe) — this link always points to the newest version.
2. Run it. It installs for the current user (no admin needed) and launches automatically.
   - Windows SmartScreen may warn on an unsigned app → *More info → Run anyway*.

**macOS**: grab the `.dmg` for your chip (`arm64` for Apple Silicon, `x64` for Intel) from the
[latest release](https://github.com/micaelmbsilva/PathOfDust_Desktop/releases/latest). The app is
unsigned — right-click → *Open* on first launch, and shell updates are applied by downloading the
new `.dmg` when the app offers it (the web UI still updates itself automatically).

A Start Menu shortcut is created for you.

### First launch — log in

On the very first run the app opens the Path of Dust login. Click **Login with Twitch** and sign
in as you normally would. That single login powers everything — your character data **and** the
chat. It’s saved, so you won’t be asked again.

### Optional — chat emotes

Want 7TV emotes in the chat panel? Install the **[7TV](https://7tv.app/)** extension in Chrome (the
app reads it from your Chrome profile). Without it, chat still works — just with standard emotes.

---

## Using it

- **Zoom the overlay:** mouse wheel over the game; double-click to reset.
- **Move a panel:** drag its title bar. Collapse with the ▾, close with ✕.
- **Open Bag / Passives:** the buttons up top open them in their own windows.
- **Refresh:** the 🔄 button (or it refreshes itself when something happens in-game).
- **Highlight your character:** the **✨ Highlight me** button.

---

## Updates

The app **updates itself** — no reinstall, ever.

- **Interface & logic** hot-update on launch: the app pulls the latest web/bridge files from this
  repo each time it starts, so day-to-day improvements arrive automatically.
- **The app itself** (the Electron shell) updates in the background via the installer feed. When a
  new version has downloaded, the app asks to restart, then applies it. Your login and layout are
  kept.

---

## Requirements

- Windows 10/11 (64-bit)
- A Twitch account with a Path of Dust character
- *(optional)* Chrome with the 7TV extension, for custom chat emotes

---

## Development

```bash
git clone https://github.com/micaelmbsilva/PathOfDust_Desktop
cd PathOfDust_Desktop
npm install
git config core.hooksPath .githooks   # one-time, per clone — see "Interface revision" below
npm start                             # launches the Electron shell
npm test                              # solver, scrape, codec, party-HP and craft-picker suites
```

First `npm start` opens the Twitch login, exactly as the installed app does. Everything after that
runs against your own character.

### How it fits together

| piece | what it is |
|---|---|
| `main.cjs` | the Electron shell — windows, auto-update, and the launch-time interface pull |
| `server.mjs` | a local HTTP bridge on `127.0.0.1`. Serves every page below and does all the talking to `adventure.lokati.net` with your session cookie |
| `index.html`, `bag.html`, `passives.html`, `character.html`, `fights.html`, `builds.html` | the pages themselves — plain HTML with inline `<script>`, no build step, no framework |
| `actions.mjs` | the write side: every form-POST the app can make |
| `solver/` | the build model — `advisor-core.mjs` (pure scoring/search functions), `game-model.json` (constants derived from the game's Rust source) and `passive-tree.json` (the node index). Used by the build dossier and covered by `solver/advisor-core.test.mjs` |
| `tools/passive-tree-export.mjs` | regenerates `solver/passive-tree.json` from the game source |
| `extension/` | the optional Chrome extension |
| `wiki/` | the wiki scraper and its snapshot |
| `server/` | **a separate deployment**, not part of the app — the public ladder site and telemetry backend (Express + Postgres, deployed to Railway). It has its own `package.json`; run `npm install && node test-server.js` inside `server/` to work on it |

`README-actions.md` documents the site's own endpoints and the session-cookie auth the bridge
drives. Read it before touching `actions.mjs` or the scrapers in `server.mjs`.

The **Build Dossier** (`builds.html`) is owner-gated to the streamer's login in `server.mjs`; it
returns 403 for everyone else. That is deliberate, not a bug you are hitting.

### Interface revision — read this before your first commit

The app hot-updates its web/bridge files from this repo at launch. `version.json` lists which files
that covers and carries an integer `version` that running clients compare against their own. **Change
a listed file without advancing that integer and your change reaches nobody.**

```bash
npm run bump   # parses version.json and increments — never edit it with sed
```

The `pre-commit` hook enforces this and fails rather than bumping for you. Full rules, including the
three separate version numbers and how a release is cut, are in [CLAUDE.md](CLAUDE.md).

### Conventions

- No build step and no runtime dependencies in the app — Node built-ins and the browser only.
- Pages are single files: styles in `<style>`, logic in `<script>`. Match the surrounding code.
- Stage explicit paths when committing (`git add <file>`), never `git add -A`.
