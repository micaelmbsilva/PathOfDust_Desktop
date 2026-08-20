# adventure.lokati.net — our own layer

The site is push-only for reads and cookie-auth form-POSTs for writes. Nothing
here is an official API; it's the site's own endpoints, driven with your session.

## Auth
Single cookie `adv_session`, **no CSRF token** — which is why every action below
is a plain form-POST.

The Electron shell owns the login. On first run it opens the site's Twitch login
in a real app window and waits for `adv_session` to appear in its own session
(`main.cjs`), then hands the cookie to the bridge with `actions.setCookie()`.
There is no browser, no CDP attach and no credential file at runtime — the
cookie lives in the Electron session and nowhere else.

When it expires the shell notices the login redirect (`loginRedirect()` in
`actions.mjs`) and shows the login window again. Nothing to re-run by hand.

## Read (open, no auth)
- `wss://adventure.lokati.net/ws` — pushes `state` (stage + full roster) and
  `encounter` (fight replay). Wired into `index.html` (our chat-free page).
- Any authed page can be re-fetched with the cookie for current item IDs, dust,
  etc. — that is what `getAuthed()` in `actions.mjs` does, and every scraper in
  `server.mjs` is built on it.

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
| `toggle-flying` | — (Wings of Flight; the form is only on the page once owned) |
| `toggle-auto-repair` | — |

A refused action still answers 303 — to `/passives?passive_failed=<reason>`;
a Memory load that applied but changed something answers 303 to
`/passives?memory_note=<what changed>`. `post()` decodes both (`redirectNote`),
so a refusal is NOT `ok`.

Item IDs and passive `node_key`s are parsed out of the authed pages by
`server.mjs` and surfaced through `/api/bag`, `/api/inventory` and
`/api/passives`. A read-only page (someone else's character) carries no form and
therefore no `node_key` — only names and "2 / 4" ranks, which is why the build
dossier maps names back through `solver/passive-tree.json`.

## NOT available this way
Stream-wide actions (`!nextencounter`, `!giftdust`, channel-point redemptions)
run through Twitch, not the site — they need a Twitch token, not `adv_session`.

## Files
- `main.cjs` — the Electron shell: windows, the Twitch login, auto-update.
- `server.mjs` — bridge on `127.0.0.1:8787`: serves the pages and
  `/api/me|inventory|passives|roster|fights|character|action`, and does all the
  scraping.
- `actions.mjs` — the action layer above (`post()`, `getAuthed()`, `setCookie()`).
- `index.html` — the shell page: overlay, stats panel, toasts, chat.
- `bag.html` / `passives.html` / `character.html` / `fights.html` — the views.

Run it with `npm start`. See the Development section of `README.md` for the rest,
including the interface-revision rule you must follow before your first commit.
