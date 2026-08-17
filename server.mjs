// Local bridge: serves our custom pages and holds the session so the browser
// (which can't touch the httpOnly cookie) can read our stats and fire actions.
// No deps. Run: node server.mjs   ->   http://localhost:8787
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { extname, join } from 'node:path';
import { post, getAuthed, loginRedirect, netStats } from './actions.mjs';
import { GAME_NAME, TELEMETRY_URL, PING_KEY } from './config.mjs';

// Anonymous telemetry/feedback → the Railway backend. No-op if no URL set.
const INSTALL = process.env.INSTALL_ID || '';
const appVersion = async () => { try { return JSON.parse(await readFile(new URL('./version.json', import.meta.url), 'utf8')).version; } catch { return 0; } };
async function telemetry(pathname, extra) {
  if (!TELEMETRY_URL) return;
  try {
    await fetch(`${TELEMETRY_URL}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pod-key': PING_KEY },
      body: JSON.stringify({ install: INSTALL, version: await appVersion(), ...extra }),
    });
  } catch { /* offline / backend down — ignore */ }
}
async function ping() {
  // Full snapshot: everything we can scrape — character name, class/level, all
  // stats, currencies, tokens, equipped + bag gear (with mods & rolls), and the
  // passive tree. The backend stores level/archetype/version in columns and the
  // rest in a JSONB blob.
  const snap = { platform: process.platform };
  try {
    const m = await me();
    snap.name = m.name; // character/Twitch name (operator opted in to collecting it)
    const lv = (m.nav || '').match(/Lv\s*(\d+)\s+([A-Za-z]+)/);
    if (lv) { snap.level = +lv[1]; snap.archetype = lv[2]; }
    snap.autoRepair = m.autoRepair;
    snap.nav = m.nav; // "Lv 62 Rogue · 💰… · …" summary line — no name
    snap.stats = Object.fromEntries((m.stats || []).map(s => [s.label, s.value]));
    if (m.reforge) snap.reforgeAvailable = m.reforge.available;
    try {
      const inv = await inventory();
      snap.dust = inv.dust; snap.sand = inv.sand; snap.tokens = inv.tokens;
      const gear = (it) => ({ slot: it.slot, name: it.name, tier: it.tier, quality: it.quality,
        primary: it.primary, mods: it.mods, sacred: it.sacred, implicits: it.implicits,
        krangled: it.krangled, protected: it.protected });
      snap.equipped = (inv.equipped || []).map(gear);
      snap.bag = (inv.bag || []).map(gear);
    } catch {}
    try {
      const p = await passives();
      snap.passives = { points: p.points, nodes: (p.nodes || []).map(n => ({ key: n.key, name: n.name, tier: n.tier, rank: n.rank })) };
    } catch {}
  } catch {}
  telemetry('/ping', snap);
}

const PORT = 8787;
const SITE = 'https://adventure.lokati.net'; // for absolute asset URLs (sprites)
// Rev of the RUNNING bridge code (vs version.json, which is the pulled files' rev).
// The UI compares them: hot-pulled pages on an old bridge -> "restart your client".
const BRIDGE_REV = 91;
const ROOT = new URL('./', import.meta.url);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.gif': 'image/gif', '.webm': 'video/webm', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

// The build dossier is an owner tool, not another public static page. Both the
// friendly endpoint and the template's filename pass through this server-side
// identity check so knowing the file name does not bypass the gate.
const OWNER_BUILDS_LOGIN = 'lokati_gaming';
export const ownerBuildsAllowed = (name) => String(name || '').trim().toLowerCase() === OWNER_BUILDS_LOGIN;

// Pull our character sheet and extract name + stat rows. Regex over the site's
// own markup — brittle-by-design is fine, it's one page we control the read of.
async function me() {
  const { text } = await getAuthed('/');
  const name = (text.match(/<h1>([^<]*)<\/h1>/) || [])[1] || 'Character';
  const nav = (text.match(/top-nav-stats">([^<]*)</) || [])[1] || '';
  const stats = statsOf(text);
  const autoRepair = /name="auto_repair"[^>]*checked/.test(text);
  // "Repair All (Nd)" in the Gear card header. The site omits the whole form
  // when nothing is damaged, so null = nothing to repair.
  const raf = text.match(/<form[^>]*action="\/repair-all"[^>]*>\s*<button([^>]*)>([^<]*)</);
  const repairAll = raf
    ? { cost: +(strip(raf[2]).match(/\((\d+)\s*d\)/) || [])[1] || 0, disabled: /\bdisabled\b/.test(raf[1]) }
    : null;
  const autoRepairTip = strip((text.match(/name="auto_repair"[^>]*>([^<]*)</) || [])[1] || '')
    || 'Auto-repair gear with dust after every boss fight';

  // Reforge Gear card: once/hour, shared between 1k-dust and channel-points.
  // Parse availability + reset + (when available) the dust form's endpoint.
  let reforge = { available: false, resetMs: 0, action: null, label: null, canDust: false };
  const ci = text.indexOf('Reforge Gear');
  const s = ci > 0 ? text.lastIndexOf('data-reset-ms', ci) : -1;
  // A miss (no data-reset-ms before the card) used to slice(-41,…) into an empty
  // string, which failed the reforge-used test and reported "available" forever —
  // the "Reforge Ready" toast then re-armed after every dismissal. Bail instead.
  if (ci > 0 && s >= 0) {
    const card = text.slice(s - 40, ci + 700);
    reforge.resetMs = +(card.match(/data-reset-ms="(\d+)"/) || [])[1] || 0;
    reforge.available = !/reforge-pill[^"]*reforge-used/.test(card);
    const f = card.match(/<form[^>]*action="([^"]+)"[^>]*>\s*<button([^>]*)>([^<]*)<\/button>/);
    if (f) { reforge.action = f[1]; reforge.canDust = !/disabled/.test(f[2]); reforge.label = strip(f[3]); }
  }
  // XP bar ("XP: 832 / 9.1K" + fill %)
  const xp = { label: strip((text.match(/xp-label">([^<]*)</) || [])[1] || ''),
    pct: +(text.match(/xp-fill" style="width:(\d+)%/) || [])[1] || 0 };
  // Wings of Flight: owned when the toggle-flying form is on the page
  const wingsCard = (text.split('Wings of Flight')[1] || '').split('</form>')[0];
  const wings = /action="\/toggle-flying"/.test(wingsCard)
    ? { owned: true, flying: /Flying: ON/.test(wingsCard) } : { owned: false, flying: false };
  // Every countdown card generically ({title, resetMs}) — Reforge Gear hourly,
  // and the Retreated banner's auto-repair timer when it appears.
  const countdowns = [...text.matchAll(/class="card countdown-card[^"]*" data-reset-ms="(\d+)"[^>]*>\s*<h2>([^<]*)<\/h2>/g)]
    .map(m => ({ title: strip(m[2]), resetMs: +m[1] }));
  // Archetype: current class + the switcher's options
  const archRegion = (text.split('<h2>Archetype</h2>')[1] || '').split('</form>')[0];
  const archetype = {
    current: strip((archRegion.match(/role-badge[^>]*>([^<]*)</) || [])[1] || ''),
    options: [...archRegion.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)</g)]
      .map(m => ({ value: m[1], selected: /selected/.test(m[2]), label: strip(m[3]) })),
  };
  // Channel-point buff/debuff activity table — only rendered while something is
  // active, exact markup unseen, so parse it generically: every row's cell texts.
  const bt = (text.match(/<table class="buff-activity-table"[\s\S]*?<\/table>/) || [])[0] || '';
  const buffTable = [...bt.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(m => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => strip(c[1])));
  // Character Model picker: a radio per sprite, plus a Custom Sprites section
  // that only exists when someone has dropped PNGs in for this login. `free`
  // covers both the global free-for-all flag and banked free changes — the site
  // has already resolved that into the button's own label.
  const mForm = (text.split('action="/change-model"')[1] || '').split('</form>')[0];
  const mBtn = mForm.match(/<button([^>]*)>([^<]*)</) || [];
  const model = mForm ? {
    current: strip((text.split('<h2>Character Model</h2>')[1] || '').match(/Current model:\s*([^<]+)/)?.[1] || ''),
    label: strip(mBtn[2] || 'Change'),
    disabled: /\bdisabled\b/.test(mBtn[1] || ''),
    options: [...mForm.matchAll(/<input type="radio" name="model" value="([^"]+)"([^>]*)>[\s\S]*?<img src="([^"]+)"[^>]*alt="([^"]*)"/g)]
      .map(m => ({ value: m[1], selected: /\bchecked\b/.test(m[2]), img: SITE + m[3], label: strip(m[4]) })),
  } : null;
  // "Purchase (Nd)" — only rendered while the character does NOT own wings.
  const pwForm = (text.split('action="/purchase-wings"')[1] || '').split('</form>')[0];
  const pwBtn = pwForm.match(/<button([^>]*)>([^<]*)</) || [];
  const buyWings = pwForm ? { label: strip(pwBtn[2] || 'Purchase'), disabled: /\bdisabled\b/.test(pwBtn[1] || '') } : null;
  // Shown instead of the whole dashboard until the character exists.
  const canJoin = /action="\/join"/.test(text);

  return { name, nav, stats, autoRepair, autoRepairTip, repairAll, reforge, xp, wings, buyWings, model, canJoin, countdowns, archetype, buffTable };
}
const strip = (s) => s.replace(/<[^>]*>/g, '')
  .replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#?\w+;/g, '').trim();

// data-tip (the site's hover text) out of an element's attribute string.
const tipOf = (attrs) => strip((attrs.match(/data-tip="([^"]*)"/) || [])[1] || '');
// HTML-entity decode for attribute values we re-submit verbatim (forms).
const decode = (s) => (s || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// modifiers with their roll-% tooltip: [{ t: "+5 max hp", tip: "Roll: 30%" }].
// Class matched as a token — the site adds classes (mod-roll-crit = the green
// Reforge/Recombine crit-granted affix), and the old exact match dropped those.
const modsOf = (chunk) => [...chunk.matchAll(/<li([^>]*)>([^<]*)</g)]
  .map(m => ({ attrs: m[1], raw: m[2], cls: ((m[1].match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/) }))
  .filter(x => x.cls.includes('mod-roll'))
  .map(x => ({ t: strip(x.raw), tip: tipOf(x.attrs), ...(x.cls.includes('mod-roll-crit') ? { crit: true } : {}) }));
// the gear-quality element's tooltip (Perfect Quality etc.)
const qtipOf = (chunk) => tipOf((chunk.match(/class="gear-quality[^"]*"([^>]*)>/) || [])[1] || '');
// Sacred/unique implicit callouts ("✦ Sacred: +224% splash" / the gold unique
// line, e.g. Celestial Shard's "✦ Celestial Conversion: …"). An item can carry
// BOTH — Krangle conflicts with unique, Sacred doesn't — so this returns every
// line in the site's own order, each with its own gold flag. The old
// single-string + separate implicitGold boolean lost the unique line entirely on
// a Sacred item and then painted the surviving Sacred line gold.
// Exported for the scrape smoke-test.
export const implicitsOf = (chunk) => [...chunk.matchAll(/class="gear-(sacred|unique)"[^>]*>([^<]*)</g)]
  .map(m => ({ t: strip(m[2]), gold: m[1] === 'unique' }))
  .filter(x => x.t);

// Durability line. Indestructible items render a word instead of a bar; items
// the site doesn't show a bar for at all come back null so the UI can tell
// "no durability concept here" from "at 100%".
export const durabilityOf = (chunk) => /class="indestructible"/.test(chunk)
  ? { pct: null, indestructible: true }
  : /class="durability-pct"/.test(chunk)
    ? { pct: +(chunk.match(/class="durability-pct"[^>]*>(\d+)%/) || [])[1] || 0, indestructible: false }
    : null;

// Repair form (/repair-item on a bag item, /repair-equipped on a worn slot).
// The site renders NOTHING when the item doesn't need repair, so absence is the
// "nothing to fix" signal — there is no flag to read. Cost lives only in the
// button's own label, "Repair (240d)".
export const repairOf = (chunk) => {
  const f = chunk.match(/<form[^>]*action="\/repair-(item|equipped)"[^>]*>([\s\S]*?)<\/form>/);
  if (!f) return null;
  const b = f[2].match(/<button([^>]*)>([^<]*)</) || [];
  const field = f[1] === 'item' ? 'item_id' : 'slot';
  const value = (f[2].match(new RegExp(`name="${field}"\\s+value="([^"]+)"`)) || [])[1];
  if (!value) return null;
  return { endpoint: `/repair-${f[1]}`, field, value,
    cost: +(strip(b[2] || '').match(/\((\d+)\s*d\)/) || [])[1] || 0,
    disabled: /\bdisabled\b/.test(b[1] || '') };
};

// Every stat card on a page: [{label, value, tip, vtip}]. The five breakdown
// stats (DR, Block, Evasion, Dmg Dealt, Intervene) hang their tooltip off the
// VALUE div, the rest off the label — so both are captured.
const statsOf = (text) => [...text.matchAll(
  /class="stat-label"([^>]*)>(.*?)<\/div>\s*<div class="stat-value"([^>]*)>(.*?)<\/div>/g)]
  .map(m => ({ label: strip(m[2]), value: strip(m[4]), tip: tipOf(m[1]), vtip: tipOf(m[3]) }));

// One gear/bag card. Shared by our own pages and other players' — the site
// builds all four of its item-card variants from the same block, so one parser
// covers them; the owner-only bits (id, protect, repair) just come back null.
const itemOf = (chunk) => {
  const grab = (cls) => strip((chunk.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');
  return {
    name: grab('gear-name'), slot: grab('gear-slot-label'), tier: grab('gear-tier'),
    quality: grab('gear-quality'), qtip: qtipOf(chunk), primary: grab('gear-primary'),
    mods: modsOf(chunk), implicits: implicitsOf(chunk),
    sacred: /gear-name-sacred/.test(chunk), unique: /gear-name-unique/.test(chunk),
    krangled: /gear-name-locked/.test(chunk),
    durability: durabilityOf(chunk),
  };
};
// Split a region into item-card chunks. Empty slots carry class="gear-slot empty"
// and no card body, so they're matched too and filtered by the caller.
const gearChunks = (region) => region.split(/class="gear-slot(?: empty)?"/).slice(1);

// Scrape the bag (unequipped items) out of the inventory page's text. Each item's
// id is the item_id its equip/disenchant forms carry; `protected` = Keep checkbox.
function bag(text) {
  const card = (text.split('class="card bag-card"')[1] || '').split('</div>\n</body>')[0];
  const items = [];
  for (const chunk of card.split('class="gear-slot"').slice(1)) {
    const id = (chunk.match(/name="item_id"\s+value="([^"]+)"/) || [])[1];
    if (!id || items.some(i => i.id === id)) continue; // dedupe (equip+disenchant forms repeat id)
    const grab = (cls) => strip((chunk.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');
    items.push({
      id, name: grab('gear-name'), slot: grab('gear-slot-label'),
      quality: grab('gear-quality'), qtip: qtipOf(chunk), tier: grab('gear-tier'),
      primary: grab('gear-primary'), mods: modsOf(chunk),
      sacred: /gear-name-sacred/.test(chunk), unique: /gear-name-unique/.test(chunk),
      implicits: implicitsOf(chunk),
      krangled: /gear-name-locked/.test(chunk),
      protected: /name="protect"[^>]*checked/.test(chunk),
      durability: durabilityOf(chunk), repair: repairOf(chunk),
      // The dust range only exists inside the disenchant form's own confirm()
      // text, and the whole form is omitted for Keep-marked items — so this is
      // null exactly when disenchanting isn't offered.
      dust: (() => {
        const m = chunk.match(/for (\d+)-(\d+) Thaumatergic Dust/);
        return m ? { min: +m[1], max: +m[2] } : null;
      })(),
    });
  }
  return { items };
}

// Party classes: the /characters roster shows "Level N Class" per player — the
// game WS roster doesn't carry class at all. Cached ~30 min; lowercased names.
// A failed/empty scrape keeps serving the last good cache.
let rosterCache = { at: 0, list: [] };
export async function roster() { // exported for scrape smoke-tests
  if (Date.now() - rosterCache.at < 30 * 60000) return rosterCache.list;
  let text;
  // site down / scrape hiccup → serve the stale cache instead of a 500; a dead
  // session still surfaces as 401 so the page can say "restart to re-login"
  try { ({ text } = await getAuthed('/characters')); }
  catch (e) { if (e.expired) throw e; return rosterCache.list; }
  const list = rosterOf(text);
  // Stamp the time even on an empty parse (markup changed) so a broken scrape
  // doesn't re-fetch /characters on every single request with no throttle —
  // keep serving the last good list until the 30-min window lapses.
  rosterCache = { at: Date.now(), list: list.length ? list : rosterCache.list };
  return rosterCache.list;
}
export function rosterOf(text) { // exported for scrape smoke-tests
  const list = [];
  for (const chunk of text.split('class="roster-card"').slice(1)) {
    const name = strip((chunk.match(/class="roster-name"[^>]*>([^<]*)</) || [])[1] || '');
    // The login only exists in the card's href — it's never printed as text.
    const login = decodeURIComponent((chunk.match(/href="\/characters\/([^"]+)"/) || [])[1] || '');
    const lv = chunk.match(/class="roster-meta"[^>]*>\s*Level\s+(\d+)\s+([A-Za-z]+)/) || [];
    // W/L go through the site's format_number, so past 1000 they arrive
    // abbreviated ("1.2K", "3.4M") — never plain digits. Kept as the strings
    // the site rendered rather than parsed back into numbers we'd only reprint.
    const wl = chunk.match(/class="roster-meta"[^>]*>\s*([\d.]+[KMBT]?)W\s*\/\s*([\d.]+[KMBT]?)L\s*\(([^)]*)\)/) || [];
    if (!name || !lv[2]) continue;
    list.push({ login, name, cls: lv[2], level: +lv[1],
      wins: wl[1] || '0', losses: wl[2] || '0', winrate: strip(wl[3] || '') || '—',
      sprite: SITE + ((chunk.match(/class="roster-sprite" src="([^"]+)"/) || [])[1] || '') });
  }
  return list;
}
// Party panel's view of the same scrape: lowercased name -> {cls, level, login}.
// The login is what /characters/:login needs — it isn't the display name.
export async function rosterClasses() {
  return Object.fromEntries((await roster())
    .map(r => [r.name.toLowerCase(), { cls: r.cls, level: r.level, login: r.login }]));
}

// Another player's character sheet. Same item-card markup as our own pages, so
// the shared parsers cover it; no forms exist here, so nothing is actionable.
async function character(login) {
  const { text } = await getAuthed('/characters/' + encodeURIComponent(login));
  return characterOf(text, login);
}
export function characterOf(text, login) { // exported for scrape smoke-tests
  if (/<h1>Not Found<\/h1>/.test(text)) return { notFound: true };
  const gearRegion = text.split(/class="bag-row/)[0];
  return {
    login,
    name: strip((text.match(/<h1>([^<]*)<\/h1>/) || [])[1] || ''),
    archetype: strip((text.match(/class="role-badge[^"]*"[^>]*>([^<]*)</) || [])[1] || ''),
    sprite: SITE + ((text.match(/class="sprite-avatar" src="([^"]+)"/) || [])[1] || ''),
    hasTree: /class="passives-link-btn"/.test(text), // absent for Commoner
    stats: statsOf(text),
    xp: { label: strip((text.match(/xp-label">([^<]*)</) || [])[1] || ''),
          pct: +(text.match(/xp-fill" style="width:(\d+)%/) || [])[1] || 0 },
    // empty slots stay in the list (name '') so the grid keeps all five cells
    equipped: gearChunks(gearRegion).map(itemOf).filter(i => i.slot),
    bag: gearChunks(text.slice(gearRegion.length)).map(itemOf).filter(i => i.name),
  };
}

// Pending choice card: a veiled/token craft (id="veil-choice") or the veiled
// Chancing walk (id="chancing-wizard") parks server-rendered forms and the
// site blocks further crafting until a choice is made. Parsed generically —
// one choice per <form>, replayed verbatim (action path + every submittable
// input + the submit button's own name/value) — so wizard variants and
// multi-step walks keep working without knowing their exact markup.
// Exported for scrape smoke-tests.
export function pendingOf(text) {
  const pendRegion = (text.split(/id="(?:veil-choice|chancing-wizard)"/)[1] || '').split('bag-card')[0];
  if (!pendRegion) return null;
  const kind = text.includes('id="chancing-wizard"') ? 'chancing' : 'veil';
  const title = strip((pendRegion.match(/<h2[^>]*>([^<]*)<\/h2>/) || [])[1] || 'Choose your outcome');
  const note = strip((pendRegion.match(/<p[^>]*>([^<]*)<\/p>/) || [])[1] || '');
  const choices = [];
  for (const fm of pendRegion.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)) {
    const action = decode((fm[1].match(/action="([^"]*)"/) || [])[1] || '/craft/choose-veil');
    if (!/^\/[\w\/.-]*$/.test(action)) continue; // same-origin relative paths only
    const inner = fm[2], fields = []; // ordered [name,value] pairs — duplicates allowed
    for (const inp of inner.matchAll(/<input([^>]*)>/g)) {
      const at = inp[1];
      if (/\bdisabled\b/.test(at)) continue;                         // successful controls only
      if (/type="(?:button|reset|submit|image)"/.test(at)) continue; // non-submitting input types
      const box = /type="(?:checkbox|radio)"/.test(at);
      if (box && !/\bchecked\b/.test(at)) continue;
      const name = decode((at.match(/name="([^"]*)"/) || [])[1] || '');
      const val = (at.match(/value="([^"]*)"/) || [])[1];
      if (name) fields.push([name, val != null ? decode(val) : box ? 'on' : '']); // valueless checked box submits "on"
    }
    const btn = inner.match(/<button([^>]*)>([\s\S]*?)<\/button>/);
    if (!btn) continue;
    const bName = decode((btn[1].match(/name="([^"]*)"/) || [])[1] || '');
    if (bName) fields.push([bName, decode((btn[1].match(/value="([^"]*)"/) || [])[1] || '')]);
    choices.push({ action, fields, label: strip(btn[2]).replace(/^Option \d+:\s*/, '') });
  }
  if (!choices.length) return null;
  const pend = { kind, title, note, choices };
  // Legacy shape for not-yet-reloaded pages (pre rev-82): veil cards used to be
  // { options: [{index, text}] } — keep emitting it so an old bag.html's
  // inv.veil.options.map() doesn't throw while a choice is pending.
  if (kind === 'veil') pend.options = choices.map((c, i) => ({
    index: +((c.fields.find(f => f[0] === 'index') || [])[1] ?? i), text: c.label }));
  return pend;
}

// "Name Your Krangled Item" prompt. Krangle is the only way to earn a nickname,
// and the site asks once per item — while `nickname` is unset it keeps
// prompting, and submitting an EMPTY value is how you decline (it records
// "asked and skipped" so it stops). Only one pending item is offered at a time
// even when several are waiting. Exported for the scrape smoke-test.
export function nameItemOf(text) {
  const form = (text.split('action="/name-item"')[1] || '').split('</form>')[0];
  if (!form) return null;
  const id = (form.match(/name="item_id"\s+value="([^"]+)"/) || [])[1];
  if (!id) return null;
  return {
    id,
    maxLen: +(form.match(/maxlength="(\d+)"/) || [])[1] || 30,
    // "You Krangled a {name} — …" is the only place the base name appears
    name: strip(((text.split('Name Your Krangled Item')[1] || '').match(/You Krangled a ([^—<]+)/) || [])[1] || ''),
  };
}

// Full inventory: currencies, tokens, equipped gear, bag, and the craft form's
// item options + action buttons. Enough to drive a custom Bag page.
export async function inventory() { // exported for scrape smoke-tests
  const { text } = await getAuthed('/inventory');
  const nav = (text.match(/top-nav-stats">([^<]*)</) || [])[1] || '';
  // Exact balances live in the craft buttons' data-dust / data-sand attributes
  // (used for affordability checks); the nav only carries the abbreviated form.
  const dust = (text.match(/data-dust="(\d+)"/) || [])[1]
    ?? (nav.match(/💰\s*([\d.KM]+)/) || [])[1] ?? '?';
  const sand = (text.match(/data-sand="(\d+)"/) || [])[1]
    ?? (nav.match(/🪵\s*([\d.KM]+)/) || [])[1] ?? '?';
  const tokens = [...text.matchAll(/class="token-pill">([^<]*)</g)].map(m => strip(m[1]));
  // Bag header prints "Bag (used/capacity)" — read the cap off the page rather
  // than copying INVENTORY_CAPACITY into our source, where it would silently rot.
  const bagCap = +(text.match(/<h2>Bag \((\d+)\/(\d+)\)<\/h2>/) || [])[2] || null;

  // Equipped: gear-slots inside the "Equipped Items" card (before bag-card).
  const equippedRegion = (text.split('Equipped Items')[1] || '').split('bag-card')[0];
  const equipped = [];
  for (const chunk of equippedRegion.split('class="gear-slot"').slice(1)) {
    const slot = (chunk.match(/name="slot"\s+value="([^"]+)"/) || [])[1];
    if (!slot) continue;
    const grab = (cls) => strip((chunk.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');
    equipped.push({
      slot, name: grab('gear-name'), quality: grab('gear-quality'), qtip: qtipOf(chunk),
      tier: grab('gear-tier'), primary: grab('gear-primary'), mods: modsOf(chunk),
      sacred: /gear-name-sacred/.test(chunk), unique: /gear-name-unique/.test(chunk),
      implicits: implicitsOf(chunk),
      krangled: /gear-name-locked/.test(chunk),
      durability: durabilityOf(chunk), repair: repairOf(chunk),
    });
  }

  // Craft form: item_a options + action buttons.
  const craftForm = (text.split('action="/craft"')[1] || '').split('</form>')[0];
  const selA = (craftForm.match(/<select name="item_a">([\s\S]*?)<\/select>/) || [])[1] || '';
  // Attribute-order independent (the site appends new data-* attrs, e.g.
  // data-polish-room in Aug '26). polishRoom: null = attr absent (old site).
  // The site groups these: an "Equipped" optgroup first, then one per slot, and
  // the label already carries tier/mod-count/quality plus 🔒 and ✦ markers. Walk
  // the markup in order so the grouping survives instead of being flattened.
  let group = '';
  const options = [...selA.matchAll(/<optgroup label="([^"]*)"|<option value="([^"]+)"([^>]*)>([^<]*)</g)]
    .map(m => {
      if (m[1] !== undefined) { group = strip(m[1]); return null; }
      const at = m[3], num = (n) => { const v = (at.match(new RegExp(`${n}="(-?\\d+)"`)) || [])[1]; return v == null ? null : +v; };
      return { id: m[2], group, affixes: num('data-affixes') ?? 0, tier: num('data-tier') ?? 0,
        quality: num('data-quality') ?? 0, perfect: num('data-perfect') === 1,
        polishRoom: num('data-polish-room'), label: strip(m[4]),
        // The site preselects whatever you crafted last.
        selected: /\bselected\b/.test(at) };
    }).filter(Boolean);
  // Capture each button's cost data so the client can replicate the live
  // per-item cost calc (base + 3*tier, veil extras, reforge 30*tier, polish).
  const actions = [...craftForm.matchAll(/name="action" value="([^"]+)"([^>]*)>([^<]*)</g)]
    .map(m => {
      const a = m[2];
      const num = (n) => { const v = (a.match(new RegExp(`${n}="(-?\\d+)"`)) || [])[1]; return v == null ? null : +v; };
      return {
        action: m[1], label: strip(m[3]), tip: tipOf(a),
        base: num('data-base'), veilExtra: num('data-veil-extra'),
        dataLabel: (a.match(/data-label="([^"]*)"/) || [])[1] || strip(m[3]).replace(/\s*\(.*\)\s*$/, ''),
        recombine: /data-recombine/.test(a), polish: /data-polish(?!-)/.test(a), reforge: /data-reforge/.test(a),
        dust: num('data-dust'), sand: num('data-sand'),
        confirm: /data-confirm/.test(a), // site marks destructive/committing crafts itself
      };
    });
  const veilTip = tipOf((craftForm.match(/class="veil-check"([^>]*)>/) || [])[1] || '');
  // Hideout Warrior's "Include Krangle" checkbox (name="hideout_krangle") —
  // null when the site doesn't render it (pre-Aug-'26 or no hideout button).
  const hk = craftForm.match(/<input([^>]*name="hideout_krangle"[^>]*)>/);
  const hideoutKrangle = hk ? { name: 'hideout_krangle', value: (hk[1].match(/value="([^"]*)"/) || [])[1] || '1', checked: /\bchecked\b/.test(hk[1]) } : null;

  // Site-side auto-disenchant setting (form POST /set-auto-disenchant):
  // enabled + threshold tier (quality|perfect|sacred) + quality-% floor.
  const adForm = (text.split('action="/set-auto-disenchant"')[1] || '').split('</form>')[0];
  const autoDisenchant = adForm ? {
    enabled: /name="enabled"[^>]*checked/.test(adForm),
    tier: (adForm.match(/<option value="([^"]+)"[^>]*\bselected\b/) || [])[1] || 'perfect',
    minPercent: +(adForm.match(/name="min_percent"[^>]*value="(\d+)"/) || [])[1] || 1,
    options: [...adForm.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)</g)].map(m => ({ value: m[1], label: strip(m[2]) })),
  } : null;

  const veil = pendingOf(text);

  // "Name Your Krangled Item" prompt. Krangle is the only way to earn a
  // nickname, and the site asks once per item — while `nickname` is unset it
  // keeps prompting, and submitting an EMPTY value is how you decline (it
  // records "asked and skipped" so it stops). Only one pending item is offered
  // at a time even if several are waiting.
  return { dust, sand, tokens, bagCap, equipped, bag: bag(text).items, craft: { options, actions, veilTip, hideoutKrangle }, veil, autoDisenchant, nameItem: nameItemOf(text) };
}

// One passive canvas out of a page fragment. The site renders the same
// `render_ptree_body` markup four ways (own tree, own 2nd-class tree, and the
// read-only versions of both), so one parser covers all of them: the read-only
// pages simply carry no form, hence no node_key and canInc/canDec false.
// `secondary` is stamped on each node because /passives/allocate needs it as a
// field to know which of the two trees the point goes into.
export function treeOf(html, secondary = false) { // exported for scrape smoke-tests
  // The live tree is an absolute canvas; grab its size + the SVG connectors
  // verbatim so we can reproduce the exact layout and dependency lines.
  const svg = (html.match(/<svg class="connectors"[\s\S]*?<\/svg>/) || [])[0] || '';
  const stage = { w: +(svg.match(/width="([\d.]+)"/) || [])[1] || 1180,
                  h: +(svg.match(/height="([\d.]+)"/) || [])[1] || 463 };
  const nodes = [];
  for (const chunk of html.split('class="node ').slice(1)) {
    // split() already ends the chunk at the next node; the 1600 cap only bounds
    // the last one, which would otherwise run to the end of the page.
    const fe = chunk.indexOf('</form>');
    const head = fe >= 0 && fe < 1600 ? chunk.slice(0, fe + 7) : chunk.slice(0, 1600);
    const root = head.startsWith('node-root');
    const grab = (cls) => strip((head.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');
    // name: full inner markup stripped, so a nested "(inactive)" span survives
    const name = strip((head.match(/class="node-name[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    if (!name && !root) continue;
    nodes.push({
      key: (head.match(/name="node_key"\s+value="([^"]+)"/) || [])[1] || null,
      secondary, name,
      tier: grab('node-kind'), rank: grab('node-rank'),
      desc: strip((head.match(/data-tip="([^"]*)"/) || [])[1] || ''),
      cls: head.slice(0, head.indexOf('"')),
      x: +(head.match(/left:\s*([\d.]+)px/) || [])[1] || 0, // tree column position
      y: +(head.match(/top:\s*([\d.]+)px/) || [])[1] || 0,  // tree row position
      w: +(head.match(/width:\s*([\d.]+)px/) || [])[1] || 140,
      canInc: /value="1"(?![^>]*disabled)/.test(head),
      canDec: /value="-1"(?![^>]*disabled)/.test(head),
    });
  }
  // edges as plain numbers as well as the raw svg — new pages draw from these
  // rather than injecting scraped markup.
  const edges = [...svg.matchAll(/x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
    .map(m => ({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] }));
  return { stage, connectors: svg, edges, nodes };
}

// Passive tree: points chip, respec/save availability, and every node. When
// Split Personality is equipped the page carries a SECOND tree below the first;
// both are parsed separately so their nodes and canvases never get mixed.
async function passives() {
  const { text } = await getAuthed('/passives');
  const si = text.indexOf('class="ptree-secondary"');
  const primaryHtml = si >= 0 ? text.slice(0, si) : text;
  const points = strip((primaryHtml.match(/points-chip[^]*?<strong>([^<]+)<\/strong>/) || [])[1] || '');
  const respecLabel = strip((text.match(/action="\/passives\/respec">\s*<button[^>]*>([^<]*)</) || [])[1] || 'Respec');
  const canSave = /action="\/passives\/save">\s*<button(?![^>]*disabled)/.test(text);
  const canReset = /action="\/passives\/reset"/.test(text); // "Reset Preview" — discard unsaved changes
  const dirty = /preview-note dirty/.test(text);            // site's "Unsaved changes." flag

  // 2nd class picker — only rendered while the Split Personality unique is
  // equipped. Its tree section stays empty until a class is actually chosen.
  let secondary = null;
  if (si >= 0) {
    const secHtml = text.slice(si);
    const form = (secHtml.split('action="/passives/set-secondary"')[1] || '').split('</form>')[0];
    secondary = {
      options: [...form.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)</g)]
        .map(m => ({ value: m[1], selected: /selected/.test(m[2]), label: strip(m[3]) })),
      buttonLabel: strip((form.match(/<button[^>]*>([^<]*)</) || [])[1] || 'Choose'),
      ...treeOf(secHtml, true),
    };
  }
  return { points, respecLabel, canSave, canReset, dirty, ...treeOf(primaryHtml), secondary };
}

// Another player's tree — same canvas, no controls. Commoners have none.
async function characterPassives(login) {
  const { text } = await getAuthed(`/characters/${encodeURIComponent(login)}/passives`);
  if (/<h1>Not Found<\/h1>/.test(text)) return { notFound: true };
  const si = text.indexOf('class="ptree-secondary"');
  const primaryHtml = si >= 0 ? text.slice(0, si) : text;
  const tree = treeOf(primaryHtml);
  return {
    name: strip((text.match(/<h1>([^<]*)<\/h1>/) || [])[1] || '').replace(/'s Passives$/, ''),
    points: strip((primaryHtml.match(/points-chip[^]*?<strong>([^<]+)<\/strong>/) || [])[1] || ''),
    archetype: strip((primaryHtml.match(/class="eyebrow"[^>]*>([^<]*)</) || [])[1] || ''),
    noTree: !tree.nodes.length, // Commoner short-circuit page
    ...tree,
    secondary: si >= 0 ? treeOf(text.slice(si), true) : null,
  };
}

// Streamer-only fight breakdown. The site hardcodes the allowed login and
// serves a bare "Not Found" card to everyone else — no nav, no header — so
// absence of the page header is how we report "you can't see this".
// How many fights the Fight History panel asks for. The summary tier retains
// 200 (SUMMARY_FIGHTS_CAPACITY), far more than the 10-fight coarse tier the
// HTML page reads — but they're a few KB each, so asking for a sane page of
// them stays cheap.
const FIGHTS_LIMIT = 50;

// /fights.json used to return the raw EncounterResult per fight, event logs
// included — 67.8 MB for 10 fights, measured 2026-08-17. It now serves a
// per-fight summary tier instead (2026-08-18): full untruncated per-player
// damage/healing/hits, loot and broken gear, a few KB each, built from the
// complete log BEFORE the overlay thinning runs. That makes it both smaller
// and more accurate than the HTML page we used to scrape — which had to
// re-parse ~10 fights x ~200k events per request and took 26s to answer.
//
// The scrape stays as a fallback for a server that predates the JSON tier.
async function fights() {
  try {
    const { status, text } = await getAuthed(`/fights.json?limit=${FIGHTS_LIMIT}`);
    if (status === 401 || status === 403) return { gated: true, fights: [] };
    if (status < 400) {
      const data = JSON.parse(text);
      if (Array.isArray(data)) return { gated: false, source: 'summary', fights: data };
    }
  } catch (e) {
    if (e.expired) throw e; // dead session — let the 401 path handle it
    // anything else (404 on an older server, malformed JSON): fall through
  }
  const { text } = await getAuthed('/fights');
  return { ...fightsOf(text), source: 'scrape' };
}
export function fightsOf(text) { // exported for scrape smoke-tests
  if (!/<h1>Fight History<\/h1>/.test(text)) return { gated: true, fights: [] };
  const list = [];
  // Drop the header card, then one entry per remaining card.
  for (const card of text.split('<div class="card">').slice(2)) {
    const title = strip((card.match(/<h2>([^<]*)<\/h2>/) || [])[1] || '');
    if (!title) continue;
    const section = (h) => (card.split(`<h3>${h}</h3>`)[1] || '').split('<h3>')[0];
    const items = (h) => [...section(h).matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)]
      .map(m => ({ text: strip(m[2]), muted: /class="muted"/.test(m[1]) }))
      .filter(x => x.text);
    list.push({
      title, won: /—\s*Won/.test(title),
      meta: strip((card.match(/<p class="muted">([^<]*)<\/p>/) || [])[1] || ''),
      boss: items('Boss Stats').map(x => x.text),
      report: items('Battle Report').map(x => x.text),
      skills: items('Skills Cast').map(x => x.text),
      loot: items('Loot').filter(x => !x.muted).map(x => x.text),
      broken: items('Broken Gear').filter(x => !x.muted).map(x => x.text),
      buffs: [...(card.match(/<tbody>([\s\S]*?)<\/tbody>/) || [, ''])[1]
        .matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
        .map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => strip(c[1])))
        .filter(r => r.length === 5),
    });
  }
  return { gated: false, fights: list };
}

// Interface hot-pull: same sha-pinned fetch the shell does at launch, but
// written next to the running bridge so static serving picks the new files up
// immediately. Changes to server.mjs/actions.mjs themselves still need an app
// restart — the running modules can't be re-imported, which is what BRIDGE_REV
// vs version.json tells the UI.
//
// Deliberately the ONLY thing that talks to GitHub. Every open page polls this
// bridge for the revision instead of checking upstream itself: raw.github
// rate-limits per IP and hands back 429s, and five windows each checking would
// reach that five times faster.
// A manifest filename must be a plain relative name in the app dir — no
// traversal, no absolute path, no drive letter, no NUL. Shared by the bridge
// pull and (mirrored) main.cjs's launch pull.
export const safeFile = (f) => typeof f === 'string' && f.length > 0 && f.length < 200
  && !/[\\/]{2}|(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:|\0/.test(f) && !/[<>:"|?*]/.test(f);

let pulling = null;          // in-flight guard — concurrent callers share one pull
let pullBackoffUntil = 0;    // set on failure so a 429 isn't hammered
async function pullInterface(opts = {}) {
  if (pulling) return pulling;
  // The backoff exists so the automatic 30-min loop doesn't hammer a rate limit.
  // A user clicking "Check for Updates" (opts.manual — every hit on the HTTP
  // route) should try anyway; otherwise the button silently reports "up to date"
  // during a backoff window and never sees a newly-pushed interface.
  if (!opts.manual && Date.now() < pullBackoffUntil) return { updated: false, throttled: true };
  pulling = (async () => {
    try {
      // 15s timeout so a stalled request can't leave `pulling` set forever,
      // which would wedge every later pull (manual and auto) for the session.
      const g = async (u, j) => { const r = await fetch(u, { headers: { 'User-Agent': 'PathOfDust' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(r.status); return j ? r.json() : r.text(); };
      const cur = await appVersion();
      const sha = (await g('https://api.github.com/repos/micaelmbsilva/PathOfDust_Desktop/commits/main', true)).sha;
      const base = `https://raw.githubusercontent.com/micaelmbsilva/PathOfDust_Desktop/${sha}`;
      const manifest = JSON.parse(await g(`${base}/version.json`));
      if (manifest.version <= cur) return { updated: false, version: cur };
      // The manifest is attacker-controlled if `main` is ever compromised. A
      // filename is interpolated straight into the write path, so a `../` or
      // absolute entry could write outside the app dir (Startup persistence,
      // overwriting the shell). Only allow plain relative names.
      if (!Array.isArray(manifest.files) || !manifest.files.every(safeFile)) {
        throw new Error('unsafe manifest file path');
      }
      const files = await Promise.all(manifest.files.map(f => g(`${base}/${f}`).then(t => [f, t]))); // all fetched before writing
      for (const [f, t] of files) await writeFile(new URL('./' + f, import.meta.url), t);
      await writeFile(new URL('./version.json', import.meta.url), JSON.stringify(manifest));
      console.log(`interface updated -> ${manifest.version}`);
      return { updated: true, version: manifest.version };
    } catch (e) {
      // Back off, but not equally for every failure. A 429 means we are the
      // problem and should stay away for a long while. Anything else — a 404
      // from a manifest listing a file that was never pushed, a dropped
      // connection — is usually transient or fixed upstream within minutes, and
      // an hour-long lockout there means one bad push freezes every client's
      // updates long after the push has been corrected.
      const rateLimited = /\b429\b/.test(String(e.message));
      pullBackoffUntil = Date.now() + (rateLimited ? 60 : 5) * 60000;
      console.error(`interface pull failed (${e.message}); retrying in ${rateLimited ? 60 : 5} min`);
      return { updated: false, error: true };
    } finally { pulling = null; }
  })();
  return pulling;
}
// Check periodically so a long-running app picks changes up on its own; the
// pages notice the new revision via /api/version and reload themselves.
setTimeout(pullInterface, 2 * 60000);
setInterval(pullInterface, 30 * 60000);

let logChain = Promise.resolve(); // serializes fight-log write+prune

const srv = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // Loopback binding doesn't stop cross-origin "simple" POSTs from a browser
    // tab (text/plain form spam, DNS rebinding). Browsers always send Origin on
    // cross-origin POSTs — reject anything that isn't our own pages. Absent
    // Origin (same-origin nav, curl, the shell) stays allowed.
    const org = req.headers.origin;
    if (req.method === 'POST' && org && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(org)) {
      res.writeHead(403); return res.end('forbidden');
    }
    // Host guard: a DNS-rebinding page resolves attacker.com to 127.0.0.1 and is
    // then same-origin with us, so it can read the GET scrape routes (name, gear,
    // feedback contacts) that carry no Origin header. A real local request always
    // has Host localhost/127.0.0.1; anything else is a rebind. Absent Host is
    // HTTP/1.0 / the shell — allowed.
    const host = req.headers.host;
    if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      res.writeHead(403); return res.end('forbidden');
    }
    res.setHeader('Cache-Control', 'no-store'); // never cache app files — always serve the current (updated) version
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`window.GAME_NAME=${JSON.stringify(GAME_NAME)};`);
    }
    if (url.pathname === '/owner/builds' || url.pathname === '/builds.html') {
      const identity = await me();
      if (!ownerBuildsAllowed(identity.name)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Not Found</title></head><body><h1>Not Found</h1></body></html>');
      }
      let page;
      try { page = await readFile(new URL('./builds.html', ROOT)); }
      catch (e) {
        if (e.code !== 'ENOENT' || !globalThis.__bundledDir) throw e;
        page = await readFile(join(globalThis.__bundledDir, 'builds.html'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (url.pathname === '/api/version') {
      let webRev = 0;
      try { webRev = JSON.parse(await readFile(new URL('./version.json', import.meta.url), 'utf8')).version; } catch {}
      // Displayed version is derived, not the raw semver: the shell major splits
      // into major.minor (29 -> "2.9", 30 -> "3.0") and the rest of the semver
      // follows, so 30.0.0 reads "3.0.0". The real semver keeps rising so
      // electron-updater ordering and release tags are untouched; this is purely
      // the user-facing number. The interface revision is reported SEPARATELY as
      // `ui` rather than occupying the patch slot — parking it there meant a
      // fresh 30.0.0 shell announced itself as "3.0.99", which reads like a
      // 99th patch of a release that just came out.
      // Old shells without global.__version fall back to the bare revision.
      const [maj, min, patch] = (globalThis.__version || '').split('.').map(Number);
      const version = maj ? `${Math.floor(maj / 10)}.${maj % 10}.${min || 0}${patch ? '.' + patch : ''}` : String(webRev);
      return json(res, { version, ui: webRev, autoUpdate: !!globalThis.__autoUpdate, bridgeRev: BRIDGE_REV,
        fightLogs: !!globalThis.__fightLogsDir }); // shell capability — old main.cjs never sets the dir
    }
    if (url.pathname === '/api/update-status') return json(res, globalThis.__update || {}); // electron-updater state
    if (url.pathname === '/api/apply-update' && req.method === 'POST') {
      const ok = typeof globalThis.__applyUpdate === 'function';
      json(res, { ok });
      if (ok) setTimeout(globalThis.__applyUpdate, 200); // quit + install the staged update
      return;
    }
    if (url.pathname === '/api/check-update') {
      // Ask electron-updater to look now; its result arrives via events into
      // global.__update, which the UI reads from /api/update-status.
      if (typeof globalThis.__checkUpdate === 'function') globalThis.__checkUpdate();
      return json(res, { version: globalThis.__version || '', update: globalThis.__update || {} });
    }
    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      const { message, contact } = await jbody(req);
      await telemetry('/feedback', { message, contact });
      return json(res, { ok: !!TELEMETRY_URL });
    }
    if (url.pathname === '/api/log-fight' && req.method === 'POST') {
      // Compact per-fight report from the page → one JSON file on disk, kept to
      // the newest 100. Shell provides the dir (packaged app only; dev = no-op).
      const dir = globalThis.__fightLogsDir;
      if (!dir) return json(res, { ok: false });
      const rep = await jbody(req);
      if (!rep || typeof rep !== 'object' || !Object.keys(rep).length) return json(res, { ok: false });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const suffix = Math.random().toString(36).slice(2, 6); // same-second fights don't collide
      const name = `${stamp}-${String(rep.stage ?? 'x').replace(/[^\w-]/g, '')}-${String(rep.kind || 'fight').replace(/[^\w-]/g, '')}-${suffix}.json`;
      // serialize write+prune — concurrent fights can't race the retention pass.
      // The queue tail swallows errors (so one failure can't poison the chain)
      // but the response awaits the unswallowed op and reports honestly.
      const op = logChain.then(async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, name), JSON.stringify(rep));
        // prune only files WE generated (ISO-stamp prefix) — never a user's own
        const mine = (await readdir(dir)).filter(f => /^\d{4}-\d{2}-\d{2}T[\w-]*\.json$/.test(f)).sort();
        for (const f of mine.slice(0, Math.max(0, mine.length - 100))) await unlink(join(dir, f)).catch(() => {});
      });
      logChain = op.catch((e) => console.error('log-fight:', e.message));
      try { await op; return json(res, { ok: true }); } catch { return json(res, { ok: false }); }
    }
    if (url.pathname === '/api/open-logs' && req.method === 'POST') {
      // Show the fight-logs folder in the OS file manager via the shell's
      // shell.openPath — no string-interpolated exec (quoting pitfalls).
      const dir = globalThis.__fightLogsDir;
      if (!dir || typeof globalThis.__openPath !== 'function') return json(res, { ok: false });
      try { await mkdir(dir, { recursive: true }); } catch { return json(res, { ok: false }); }
      const err = await globalThis.__openPath(dir); // shell.openPath resolves '' on success, error string otherwise
      return json(res, { ok: !err });
    }
    if (url.pathname === '/api/broadcast' && req.method === 'POST') {
      // Operator banner → backend /broadcast (empty message clears it). Auth is
      // the operator key (x-pod-owner), held only on the operator's machine —
      // NOT the client-shipped PING_KEY. Without it this bridge isn't an operator
      // and can't broadcast, so we don't even call the backend.
      const key = globalThis.__operatorKey;
      if (!TELEMETRY_URL || !key) return json(res, { ok: false, notOperator: true });
      const { message } = await jbody(req);
      if (message != null && typeof message !== 'string') return json(res, { ok: false });
      try {
        const r = await fetch(`${TELEMETRY_URL}/broadcast`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pod-owner': key },
          body: JSON.stringify({ message: (message || '').slice(0, 500) }),
          signal: AbortSignal.timeout(10000),
        });
        return json(res, { ok: r.ok });
      } catch { return json(res, { ok: false }); }
    }
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const { level, message } = await jbody(req);
      telemetry('/log', { level, message });
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/feedback-list') {
      // Operator inbox: proxy the backend's feed. Gated on the operator key, not
      // the public PING_KEY — otherwise anyone could read users' feedback contacts.
      const key = globalThis.__operatorKey;
      if (!TELEMETRY_URL || !key) return json(res, []);
      try {
        const r = await fetch(`${TELEMETRY_URL}/feedback-recent`,
          { headers: { 'x-pod-owner': key }, signal: AbortSignal.timeout(10000) });
        return json(res, r.ok ? await r.json() : []);
      } catch { return json(res, []); }
    }
    if (url.pathname === '/api/roster-classes') {
      return json(res, await rosterClasses());
    }
    if (url.pathname === '/api/roster') {
      return json(res, await roster());
    }
    if (url.pathname === '/api/character' || url.pathname === '/api/character-passives') {
      // Path segment goes straight into a URL we fetch with the session cookie —
      // keep it to the shape Twitch logins actually take.
      const login = url.searchParams.get('login') || '';
      if (!/^[a-z0-9_]{1,40}$/i.test(login)) { res.writeHead(400); return res.end('bad login'); }
      return json(res, url.pathname === '/api/character'
        ? await character(login) : await characterPassives(login));
    }
    if (url.pathname === '/api/fights') {
      return json(res, await fights());
    }
    if (url.pathname === '/api/netstats') {
      // How much this bridge has pulled off the game site since it started.
      // Read-only; nothing acts on it. The page adds its own WebSocket numbers.
      return json(res, { since: netStats.since, paths: netStats.paths });
    }
    if (url.pathname === '/api/me') {
      return json(res, await me());
    }
    if (url.pathname === '/api/inventory') {
      return json(res, await inventory());
    }
    if (url.pathname === '/api/passives') {
      return json(res, await passives());
    }
    if (url.pathname === '/api/pull-interface' && req.method === 'POST') {
      // Every hit here is user-initiated (Refresh / Check for Updates), so it
      // bypasses the automatic loop's backoff and always attempts a fetch.
      return json(res, await pullInterface({ manual: true }));
    }
    if (url.pathname === '/api/open-wiki' && req.method === 'POST') {
      // Open the game wiki in the user's default browser. Fixed URL on purpose —
      // no url parameter, so this can't be steered anywhere else.
      exec('start "" "https://adventure.lokati.net/wiki"');
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/open' && req.method === 'POST') {
      // Same, generic: allowlisted site pages only.
      const PAGES = { 'wiki': '/wiki', 'patch-notes': '/patch-notes' };
      const p = PAGES[(await jbody(req)).page];
      if (!p) { res.writeHead(400); return res.end('bad page'); }
      exec(`start "" "https://adventure.lokati.net${p}"`);
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/refocus' && req.method === 'POST') {
      // Shell-level focus restore (see main.cjs __refocus). No-op on old shells.
      if (typeof globalThis.__refocus === 'function') globalThis.__refocus();
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const { endpoint, fields } = await jbody(req);
      const r = await post(endpoint, fields || {});
      // Success-looking 302 to the login page = dead session; tell the UI apart
      // from a normal craft redirect so it can say "restart to re-login".
      if (r.ok && loginRedirect(r.location)) r.expired = true;
      return json(res, r);
    }
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = new URL('.' + p, ROOT);
    // ROOT is the RESOLVED app dir, which is userData/app once an interface
    // hot-pull has happened. Binaries (icons, artwork) are never there — the
    // updater fetches every file as text, so images only ever exist in the
    // bundled install. Fall back to it before giving up. url.pathname is
    // already normalised by the URL parser, so it can't climb out with '..'.
    let data;
    try { data = await readFile(file); }
    catch (e) {
      if (e.code !== 'ENOENT' || !globalThis.__bundledDir) throw e;
      data = await readFile(join(globalThis.__bundledDir, p));
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.expired) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"expired":true}'); }
    if (e.status === 413) { try { res.writeHead(413); return res.end('body too large'); } catch { return; } }
    res.writeHead(e.code === 'ENOENT' ? 404 : 500);
    res.end(String(e.message || e));
  }
});
// Resolves once the bridge is accepting connections — the shell awaits this
// instead of polling the port.
export const ready = new Promise((resolve, reject) => {
  srv.once('error', reject);
  // loopback only — the bridge holds the user's session and (new) fs side effects
  srv.listen(PORT, '127.0.0.1', () => { console.log(`bridge on http://localhost:${PORT}`); resolve(); });
});

const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
// 2MB byte cap — fight reports are the biggest client, and they're compact by
// design. Overflow rejects (typed 413, handled by the route catch-all) so route
// logic never runs on a truncated body; connection errors resolve empty.
// Collect chunks as Buffers and decode ONCE at the end — `b += c` decoded each
// chunk on its own, so a UTF-8 sequence split across a 64KB boundary became
// U+FFFD (a nickname/report with a non-ASCII char near the boundary corrupted or
// failed JSON.parse).
const body = (req) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => {
    n += c.length; // Buffer bytes, not decoded chars
    if (n > 2e6) { const e = new Error('body too large'); e.status = 413; req.destroy(); return reject(e); }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => resolve(''));
});
// Parse a JSON body without throwing into the route's catch-all (which answers a
// raw 500). Returns {} on empty or malformed input.
const jbody = async (req) => { try { return JSON.parse(await body(req) || '{}'); } catch { return {}; } };

// usage heartbeat: once ~after login, then every 30 min
setTimeout(ping, 20000);
setInterval(ping, 30 * 60000);
