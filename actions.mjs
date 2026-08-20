// Action layer for adventure.lokati.net.
// Auth is a single cookie (adv_session) — no CSRF — so every dashboard action is
// a plain form-POST. The Electron shell sets the cookie via setCookie() after the
// user's in-app Twitch OAuth; there is no browser at runtime.
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
  if (!runtimeCookie) throw new Error('Not logged in.');
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
export const redirectNote = (location) => {
  const q = String(location || '').split('?')[1];
  if (!q) return null;
  const p = new URLSearchParams(q);
  const reason = p.get('passive_failed'), note = p.get('memory_note');
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
  // Expired adv_session: the site 302s to its login page, which fetch follows —
  // so an "OK" response can actually be the logged-out page. Without this every
  // scrape silently parses as an empty inventory/character. res.redirected
  // guards against non-redirect pages (maintenance etc.) that merely mention login.
  if (res.redirected && /Login with Twitch/i.test(text.slice(0, 30000)) && !text.includes('top-nav-stats')) {
    const e = new Error('session expired'); e.expired = true; throw e;
  }
  return { status: res.status, text: firstBody(text) };
}
// A craft/equip POST against a dead session 302s to the login page too.
export const loginRedirect = (location) => !!location && /login|signin|twitch/i.test(location);
