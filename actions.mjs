// Action layer for adventure.lokati.net.
// Auth is a single cookie (adv_session) — no CSRF — so every dashboard action
// is a plain form-POST. No browser at runtime: we read the cookie harvested
// into auth.json and fetch directly.
//
// Library:  import { post, check } from './actions.mjs'
// CLI:      node actions.mjs --check
//           node actions.mjs <endpoint> key=val key=val ...
//   e.g.    node actions.mjs craft action=transmute item_a=5b1b41081c96cc66
//           node actions.mjs equip item_id=ea32d0c3828d76e9
//           node actions.mjs passives/allocate node_key=frenzy delta=1
//           node actions.mjs disenchant-all
//
// Known endpoints (see README-actions.md): craft, equip, unequip, disenchant,
// disenchant-all, toggle-disenchant-protect, passives/allocate|save|reset|respec,
// change-archetype, change-model, purchase-wings, toggle-auto-repair.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://adventure.lokati.net';
// Session file: external path (set by the packaged app) wins, else local.
const STATE = process.env.LOKATI_AUTH ? pathToFileURL(process.env.LOKATI_AUTH)
  : new URL('./auth.json', import.meta.url);

// Runtime cookie set by the app after the user's in-app Twitch login (multi-user
// build). Takes precedence over any auth.json file (dev convenience only).
let runtimeCookie = null;
export function setCookie(header) { runtimeCookie = header || null; }
export function isAuthed() { return !!runtimeCookie; }

async function cookieHeader() {
  if (runtimeCookie) return runtimeCookie;
  const state = JSON.parse(await readFile(STATE, 'utf8')); // dev fallback
  const c = state.cookies?.filter(c => c.domain.includes('lokati.net'));
  if (!c?.length) throw new Error('Not logged in.');
  return c.map(x => `${x.name}=${x.value}`).join('; ');
}

// POST form-encoded fields to an endpoint. Returns {status, location, ok}.
// redirect:'manual' so a 303 (the normal success path) isn't auto-followed.
export async function post(endpoint, fields = {}) {
  const res = await fetch(`${ORIGIN}/${endpoint.replace(/^\//, '')}`, {
    method: 'POST',
    headers: {
      'Cookie': await cookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location'), ok: res.status < 400 };
}

// Authenticated GET — returns the response text. For scraping our own pages.
export async function getAuthed(path = '/') {
  const res = await fetch(`${ORIGIN}/${path.replace(/^\//, '')}`, {
    headers: { 'Cookie': await cookieHeader() },
  });
  return { status: res.status, text: await res.text() };
}

// Read-only auth check: GET / and see if the login gate is gone. Safe self-test.
export async function check() {
  const res = await fetch(`${ORIGIN}/`, { headers: { 'Cookie': await cookieHeader() } });
  const html = await res.text();
  return { authed: !html.includes('Login with Twitch'), status: res.status };
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--check') {
    const r = await check();
    console.log(r.authed ? `AUTHED (${r.status})` : `NOT authed (${r.status}) — re-harvest`);
    process.exit(r.authed ? 0 : 1);
  }
  const fields = Object.fromEntries(rest.map(kv => {
    const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)];
  }));
  const r = await post(cmd, fields);
  console.log(`POST /${cmd} ${JSON.stringify(fields)} -> ${r.status}${r.location ? ' redirect ' + r.location : ''}`);
  process.exit(r.ok ? 0 : 1);
}
