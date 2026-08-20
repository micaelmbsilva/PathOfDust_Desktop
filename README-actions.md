# adventure.lokati.net — our own layer

The site is push-only for reads and cookie-auth form-POSTs for writes. Nothing
here is an official API; it's the site's own endpoints, driven with your session.

## Auth
Single cookie `adv_session`, **no CSRF token**. Harvested into `auth.json`.

- Twitch login refuses to complete inside an automation-controlled browser, so
  we log in with a *human-launched* Chrome and attach over CDP to harvest the
  session. See `run.txt` then `node harvest.mjs`.
- The cookie eventually expires. When `node actions.mjs --check` prints
  `NOT authed`, re-run the harvest steps.

## Read (open, no auth)
- `wss://adventure.lokati.net/ws` — pushes `state` (stage + full roster) and
  `encounter` (fight replay). Wired into `index.html` (our chat-free page).
- Any authed page can be re-fetched with the cookie for current item IDs, dust,
  etc. (`authed/*.html` are snapshots from the last harvest.)

## Write — all POST, form-encoded, cookie only
Run: `node actions.mjs <endpoint> key=val ...`  (or import `{ post }`).

| Endpoint | Fields |
|---|---|
| `craft` | `action`=transmute\|scour\|augment\|regal\|exalt\|krangle\|polishing\|reforge\|recombine · `item_a` · `item_b`(recombine) · `veiled`=1 |
| `equip` | `item_id` |
| `unequip` | `slot`=weapon\|helm\|body\|gloves\|boots |
| `disenchant` | `item_id` |
| `disenchant-all` | — |
| `toggle-disenchant-protect` | `item_id` · `protect`=on |
| `passives/allocate` | `node_key` · `delta`=1\|-1 · `secondary`=true\|false (Split Personality's 2nd tree) |
| `passives/save` \| `passives/reset` \| `passives/respec` | — |
| `passives/set-secondary` | `archetype` (needs Split Personality equipped) |
| `passives/set-golem-type` | `slot` · `golem_type` (Elementalist only) |
| `passives/memories/save` | `slot` · `name` (blank = the site's default name) |
| `passives/memories/load` \| `passives/memories/delete` | `slot` |
| `passives/memories/rename` | `slot` · `name` |
| `change-archetype` | `archetype` |
| `change-model` | `model` |
| `purchase-wings` | — |
| `toggle-auto-repair` | — |

A refused action still answers 303 — to `/passives?passive_failed=<reason>`;
a Memory load that applied but changed something answers 303 to
`/passives?memory_note=<what changed>`. `post()` decodes both (`redirectNote`),
so a refusal is NOT `ok`.

Item IDs and passive `node_key`s come from the authed pages
(`authed/inventory.html`, `authed/passives.html`).

## NOT available this way
Stream-wide actions (`!nextencounter`, `!giftdust`, channel-point redemptions)
run through Twitch, not the site — they need a Twitch token, not `adv_session`.

## Launch as an app
`start.cmd` (double-click) or `node app.mjs` — starts the bridge and opens a
chromeless Chrome app window at `localhost:8787`. Bag/Passives open as in-app
panels (SPA), not popups. Needs Chrome installed; not a standalone .exe (that
would be the Electron path: `npm i -D electron` + a small `main.cjs`).

## Files
- `app.mjs` / `start.cmd` — launcher: bridge + Chrome app window.
- `server.mjs` — bridge: serves pages + `/api/me|bag|inventory|passives|action`.
- `index.html` — SPA shell: overlay, stats modal, toasts, in-app panels.
- `bag.html` / `passives.html` — custom Bag + Passives views (bridge-driven).
- `harvest.mjs` — CDP session harvest + authed-page crawl.
- `actions.mjs` — the action layer (`--check`, generic POST, CLI + library).
- `auth.json` — harvested session. **Secret — do not commit/share.**
