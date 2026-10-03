// Action layer for adventure.lokati.net.
// Auth is a single cookie (adv_session) — no CSRF — so every dashboard action is
// a plain form-POST. The Electron shell sets the cookie via setCookie() after the
// user's in-app account login (/account/login); there is no browser at runtime.
//
// Known endpoints (see README-actions.md): craft, equip, unequip, disenchant,
// disenchant-all, toggle-disenchant-protect, passives/allocate|save|reset|respec,
// change-archetype, change-model, purchase-wings, toggle-auto-repair.
const ORIGIN = 'https://adventure.lokati.net';

// How much we actually pull off the game site, per page. Measurement only —
// nothing reads this to make a decision. The overlay WebSocket (the other, and
// probably bigger, half of the app's traffic) is counted in index.html, since
// the page connects to it directly and never comes through here.
// Sizes are String.length (UTF-16 code units), not bytes: near-exact for this
// mostly-ASCII HTML, slightly under for non-ASCII display names.
// `ms` is wall time from request to body-in-hand, summed — divided by `n` it's
// the round trip a craft actually waits on, which is otherwise unknowable from
// this side (a craft costs one POST plus one /inventory read, both counted).
export const netStats = { since: Date.now(), paths: {} };
const timed = (key, ms, size = 0) => {
  const st = (netStats.paths[key] ||= { n: 0, size: 0, ms: 0 });
  st.n++; st.size += size; st.ms += ms;
};
// Collapse per-player pages into one bucket so a roster browse doesn't produce
// a hundred single-hit rows. Exported for the smoke-test.
export const netKey = (path) => ('/' + String(path || '/').replace(/^\//, ''))
  .split(/[?#]/)[0]
  .replace(/^\/characters\/[^/]+(\/.*)?$/, (_, rest) => '/characters/*' + (rest || ''))
  .replace(/\/+$/, '') || '/';

// Cookie set by the app after login. Required — every request needs it.
let runtimeCookie = null;
export function setCookie(header) { runtimeCookie = header || null; }

function cookieHeader() {
  // Flagged expired so the bridge answers 401 {expired:true} — the pages then
  // offer "Log in again" instead of showing a bare 500.
  if (!runtimeCookie) { const e = new Error('Not logged in.'); e.expired = true; throw e; }
  return runtimeCookie;
}

// POST form-encoded fields to an endpoint. Returns {status, location, ok}.
// redirect:'manual' so a 303 (the normal success path) isn't auto-followed.
export async function post(endpoint, fields = {}) {
  const t0 = Date.now();
  const res = await fetch(`${ORIGIN}/${endpoint.replace(/^\//, '')}`, {
    method: 'POST',
    headers: {
      'Cookie': cookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  // No body to size — redirect:'manual' means the 303 is the whole response.
  timed('POST ' + netKey(endpoint), Date.now() - t0);
  const location = res.headers.get('location');
  const n = redirectNote(location);
  return { status: res.status, location, ok: res.status < 400 && !n?.reason, ...(n || {}) };
}

// The site refuses an action by 303ing to `...?passive_failed=<reason>` — a
// <400 status, so `ok` alone read every refusal as a success and the UI showed
// nothing. That is how an allocate the server rejected (no points left, node
// locked, in a fight) silently did nothing, and it bites hardest with Split
// Personality, where two trees draw down one shared point pool. Decoded once
// here so allocate/save/respec/set-secondary/set-golem-type and every Memory
// action are covered, not just the one call site that hand-parsed it.
// `memory_note` is the mirror image: a SUCCESS the site wants to explain
// (class changed, stale nodes refunded, 2nd tree skipped).
// The crafting card grew the same two shapes (Aug/Sep '26): a refused craft
// 303s to `/inventory?craft_failed=<reason>` (a Keep-ticked item, not enough
// dust, ...) and a Divinity run reports its summary as
// `/inventory?divinity_run=1&change=<summary>`.
export const redirectNote = (location) => {
  const q = String(location || '').split('?')[1];
  if (!q) return null;
  const p = new URLSearchParams(q);
  const reason = p.get('passive_failed') ?? p.get('craft_failed');
  const note = p.get('memory_note') ?? (p.has('divinity_run') ? (p.get('change') || 'Divinity run complete.') : null);
  return reason ? { reason } : note ? { note } : null;
};

// The game's page shell currently renders each page body TWICE (its own
// templates/base.html emits it in two places). Every whole-page sweep in
// server.mjs then read every stat, roster card, tree node and token pill twice —
// which is what put two of every card on the character sheet. Every body starts
// with its top nav, and `class="top-nav"` appears exactly once per copy (never
// in the shell), so a second one marks the start of a second copy: keep the
// first. A no-op the moment the site stops doubling, and on the logged-out page
// and /fights.json, which carry no nav at all.
export const firstBody = (text) => {
  const first = text.indexOf('class="top-nav"');
  const second = first < 0 ? -1 : text.indexOf('class="top-nav"', first + 1);
  return second < 0 ? text : text.slice(0, second);
};

export const MUST_CHANGE_PASSWORD = 'Your account is using a temporary password. Open adventure.lokati.net in your web browser, log in, and set a new password — the app picks up again on its own once that is done.';
// Authenticated GET — returns the response text. For scraping our own pages.
// 5xx (incl. Cloudflare's 52x error pages when the game is down) throws so the
// scrape routes 500 and the UI shows its downtime state instead of parsing junk.
export async function getAuthed(path = '/') {
  const t0 = Date.now();
  const res = await fetch(`${ORIGIN}/${path.replace(/^\//, '')}`, {
    headers: { 'Cookie': cookieHeader() },
  });
  if (res.status >= 500) throw new Error(`site down: ${res.status}`);
  const text = await res.text();
  timed(netKey(path), Date.now() - t0, text.length);
  // Expired adv_session. /fights.json says so with a real 401; the HTML pages
  // (/, /inventory, /passives) instead render the logged-out card with a 200
  // and no redirect, so an "OK" response can actually be the logged-out page —
  // without this every scrape silently parses as an empty inventory/character.
  if (res.status === 401 || loggedOutPage(text)) {
    const e = new Error('session expired'); e.expired = true; throw e;
  }
  // An owner-issued temporary password (site, 2026-10-02) parks the account:
  // every page 303s to /account/change-password until a new one is set, and
  // that form page parsed as a character called "Set a new password" with
  // nothing in it. Not expired — logging in again lands in the same place.
  if (res.redirected && new URL(res.url).pathname === '/account/change-password') {
    const e = new Error(MUST_CHANGE_PASSWORD); e.mustChangePassword = true; throw e;
  }
  return { status: res.status, text: firstBody(text) };
}
// The logged-out card (render_logged_out in the game's adventure_web.rs) is the
// only thing the site serves without a session: both account links, and never
// the top-nav stats span that every logged-in page carries. Cloudflare error
// pages are 5xx and thrown before this; there is no maintenance page to
// confuse it. Two things the live page taught us (2026-09-02): the page shell
// inlines its whole stylesheet, so the bare token "top-nav-stats" appears on
// EVERY page (as `.top-nav-stats {`) — only the rendered `class="top-nav-stats"`
// means a session — and that stylesheet pushes the card past 40 KB, so no
// "first N KB" window: the whole body is already in memory, scan all of it.
export const loggedOutPage = (text) => {
  const s = String(text || '');
  return !s.includes('class="top-nav-stats"')
    && s.includes('href="/account/login"') && s.includes('href="/account/register"');
};
// Startup session check: /fights.json answers 401 to a dead session and a JSON
// array to a live one, in a few hundred bytes. Strict on purpose — anything
// else (edge error page, 404 from an older server) is a site problem, never
// "logged in": throws without `expired` so the caller carries on to the
// renderer's own downtime handling.
export async function probeSession() {
  const res = await fetch(`${ORIGIN}/fights.json?limit=1`, { headers: { 'Cookie': cookieHeader() } });
  if (res.status === 401) { const e = new Error('session expired'); e.expired = true; throw e; }
  if (res.status !== 200) throw new Error(`site problem: ${res.status}`);
  let data; try { data = JSON.parse(await res.text()); } catch { throw new Error('site problem: non-JSON'); }
  if (!Array.isArray(data)) throw new Error('site problem: unexpected body');
  return true;
}
// Log out: the site drops the server session and answers 302 + a Max-Age=0
// cookie. redirect:'manual' on purpose — following it lands on the logged-out
// card, which getAuthed() would (correctly) report as `expired`. Whatever the
// site says, the bridge forgets the cookie: the shell's relogin() is what
// clears the Electron jar and opens the account login afterwards.
export async function logout() {
  try {
    const res = await fetch(`${ORIGIN}/logout`, { headers: { 'Cookie': cookieHeader() }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    return { status: res.status };
  } finally { setCookie(null); }
}
// A craft/equip POST against a dead session may 302 to the login page
// (/account/login matches on "login"); most just 303 home silently, so this
// stays best-effort and the page scrape's loggedOutPage check is the real guard.
export const loginRedirect = (location) => !!location && /login|signin|twitch/i.test(location);
