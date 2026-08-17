// Action layer for adventure.lokati.net.
// Auth is a single cookie (adv_session) — no CSRF — so every dashboard action is
// a plain form-POST. The Electron shell sets the cookie via setCookie() after the
// user's in-app Twitch OAuth; there is no browser at runtime.
//
// Known endpoints (see README-actions.md): craft, equip, unequip, disenchant,
// disenchant-all, toggle-disenchant-protect, passives/allocate|save|reset|respec,
// change-archetype, change-model, purchase-wings, toggle-auto-repair.
const ORIGIN = 'https://adventure.lokati.net';

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
  const res = await fetch(`${ORIGIN}/${endpoint.replace(/^\//, '')}`, {
    method: 'POST',
    headers: {
      'Cookie': cookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location'), ok: res.status < 400 };
}

// Authenticated GET — returns the response text. For scraping our own pages.
// 5xx (incl. Cloudflare's 52x error pages when the game is down) throws so the
// scrape routes 500 and the UI shows its downtime state instead of parsing junk.
export async function getAuthed(path = '/') {
  const res = await fetch(`${ORIGIN}/${path.replace(/^\//, '')}`, {
    headers: { 'Cookie': cookieHeader() },
  });
  if (res.status >= 500) throw new Error(`site down: ${res.status}`);
  const text = await res.text();
  // Expired adv_session: the site 302s to its login page, which fetch follows —
  // so an "OK" response can actually be the logged-out page. Without this every
  // scrape silently parses as an empty inventory/character. res.redirected
  // guards against non-redirect pages (maintenance etc.) that merely mention login.
  if (res.redirected && /Login with Twitch/i.test(text.slice(0, 30000)) && !text.includes('top-nav-stats')) {
    const e = new Error('session expired'); e.expired = true; throw e;
  }
  return { status: res.status, text };
}
// A craft/equip POST against a dead session 302s to the login page too.
export const loginRedirect = (location) => !!location && /login|signin|twitch/i.test(location);
