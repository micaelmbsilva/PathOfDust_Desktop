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
