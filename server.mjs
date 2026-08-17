// Local bridge: serves our custom pages and holds the session so the browser
// (which can't touch the httpOnly cookie) can read our stats and fire actions.
// No deps. Run: node server.mjs   ->   http://localhost:8787
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { extname, join } from 'node:path';
import { post, getAuthed, loginRedirect } from './actions.mjs';
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
// Rev of the RUNNING bridge code (vs version.json, which is the pulled files' rev).
// The UI compares them: hot-pulled pages on an old bridge -> "restart your client".
const BRIDGE_REV = 74;
const ROOT = new URL('./', import.meta.url);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// Pull our character sheet and extract name + stat rows. Regex over the site's
// own markup — brittle-by-design is fine, it's one page we control the read of.
async function me() {
  const { text } = await getAuthed('/');
  const name = (text.match(/<h1>([^<]*)<\/h1>/) || [])[1] || 'Character';
  const nav = (text.match(/top-nav-stats">([^<]*)</) || [])[1] || '';
  const stats = [];
  const re = /class="stat-label"([^>]*)>(.*?)<\/div><div class="stat-value"[^>]*>(.*?)<\/div>/g;
  for (let m; (m = re.exec(text)); ) stats.push({ label: strip(m[2]), value: strip(m[3]), tip: tipOf(m[1]) });
  const autoRepair = /name="auto_repair"[^>]*checked/.test(text);
  const autoRepairTip = strip((text.match(/name="auto_repair"[^>]*>([^<]*)</) || [])[1] || '')
    || 'Auto-repair gear with dust after every boss fight';

  // Reforge Gear card: once/hour, shared between 1k-dust and channel-points.
  // Parse availability + reset + (when available) the dust form's endpoint.
  let reforge = { available: false, resetMs: 0, action: null, label: null, canDust: false };
  const ci = text.indexOf('Reforge Gear');
  if (ci > 0) {
    const s = text.lastIndexOf('data-reset-ms', ci);
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
  return { name, nav, stats, autoRepair, autoRepairTip, reforge, xp, wings, countdowns, archetype, buffTable };
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
    });
  }
  return { items };
}

// Party classes: the /characters roster shows "Level N Class" per player — the
// game WS roster doesn't carry class at all. Cached ~30 min; lowercased names.
// A failed/empty scrape keeps serving the last good cache.
let rosterCache = { at: 0, classes: {} };
export async function rosterClasses() { // exported for scrape smoke-tests
  if (Date.now() - rosterCache.at < 30 * 60000) return rosterCache.classes;
  let text;
  // site down / scrape hiccup → serve the stale cache instead of a 500; a dead
  // session still surfaces as 401 so the page can say "restart to re-login"
  try { ({ text } = await getAuthed('/characters')); }
  catch (e) { if (e.expired) throw e; return rosterCache.classes; }
  const classes = {};
  for (const chunk of text.split('class="roster-card"').slice(1)) {
    const name = strip((chunk.match(/class="roster-name"[^>]*>([^<]*)</) || [])[1] || '');
    const m = chunk.match(/class="roster-meta"[^>]*>\s*Level\s+(\d+)\s+([A-Za-z]+)/) || [];
    if (name && m[2]) classes[name.toLowerCase()] = { cls: m[2], level: +m[1] };
  }
  if (Object.keys(classes).length) rosterCache = { at: Date.now(), classes };
  return rosterCache.classes;
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
    });
  }

  // Craft form: item_a options + action buttons.
  const craftForm = (text.split('action="/craft"')[1] || '').split('</form>')[0];
  const selA = (craftForm.match(/<select name="item_a">([\s\S]*?)<\/select>/) || [])[1] || '';
  // Attribute-order independent (the site appends new data-* attrs, e.g.
  // data-polish-room in Aug '26). polishRoom: null = attr absent (old site).
  const options = [...selA.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)</g)]
    .map(m => {
      const at = m[2], num = (n) => { const v = (at.match(new RegExp(`${n}="(-?\\d+)"`)) || [])[1]; return v == null ? null : +v; };
      return { id: m[1], affixes: num('data-affixes') ?? 0, tier: num('data-tier') ?? 0,
        quality: num('data-quality') ?? 0, perfect: num('data-perfect') === 1,
        polishRoom: num('data-polish-room'), label: strip(m[3]) };
    });
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

  return { dust, sand, tokens, equipped, bag: bag(text).items, craft: { options, actions, veilTip, hideoutKrangle }, veil, autoDisenchant };
}

// Passive tree: points chip, respec/save availability, and every node.
async function passives() {
  const { text } = await getAuthed('/passives');
  const points = strip((text.match(/points-chip[^]*?<strong>([^<]+)<\/strong>/) || [])[1] || '');
  const respecLabel = strip((text.match(/action="\/passives\/respec">\s*<button[^>]*>([^<]*)</) || [])[1] || 'Respec');
  const canSave = /action="\/passives\/save">\s*<button(?![^>]*disabled)/.test(text);
  const canReset = /action="\/passives\/reset"/.test(text); // "Reset Preview" — discard unsaved changes
  const dirty = /preview-note dirty/.test(text);            // site's "Unsaved changes." flag
  // The live tree is an absolute canvas; grab its size + the SVG connectors
  // verbatim so we can reproduce the exact layout and dependency lines.
  const svg = (text.match(/<svg class="connectors"[\s\S]*?<\/svg>/) || [])[0] || '';
  const stage = { w: +(svg.match(/width="(\d+)"/) || [])[1] || 1180,
                  h: +(svg.match(/height="(\d+)"/) || [])[1] || 463 };
  const nodes = [];
  for (const chunk of text.split('class="node ').slice(1)) {
    const fe = chunk.indexOf('</form>');
    const head = fe >= 0 ? chunk.slice(0, fe + 7) : chunk.slice(0, 900); // node-root has no form
    const key = (head.match(/name="node_key"\s+value="([^"]+)"/) || [])[1] || null;
    if (!key && !head.startsWith('node-root')) continue; // keyless + not the class passive -> not a node
    const grab = (cls) => strip((head.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');
    nodes.push({
      // name: full inner markup stripped, so a nested "(inactive)" span survives
      key, name: strip((head.match(/class="node-name[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || ''),
      tier: grab('node-kind'), rank: grab('node-rank'),
      desc: strip((head.match(/data-tip="([^"]*)"/) || [])[1] || ''),
      cls: head.slice(0, head.indexOf('"')),
      x: +(head.match(/left:\s*(\d+)px/) || [])[1] || 0, // tree column position
      y: +(head.match(/top:\s*(\d+)px/) || [])[1] || 0,  // tree row position
      w: +(head.match(/width:\s*(\d+)px/) || [])[1] || 140,
      canInc: /value="1"(?![^>]*disabled)/.test(head),
      canDec: /value="-1"(?![^>]*disabled)/.test(head),
    });
  }
  return { points, respecLabel, canSave, canReset, dirty, stage, connectors: svg, nodes };
}

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
    res.setHeader('Cache-Control', 'no-store'); // never cache app files — always serve the current (updated) version
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`window.GAME_NAME=${JSON.stringify(GAME_NAME)};`);
    }
    if (url.pathname === '/api/version') {
      let webRev = 0;
      try { webRev = JSON.parse(await readFile(new URL('./version.json', import.meta.url), 'utf8')).version; } catch {}
      // Displayed version is derived, not the raw semver: the shell major splits
      // into major.minor (29 -> "2.9", 30 -> "3.0") and the patch slot shows the
      // interface revision — e.g. shell 29.0.0 + interface 38 -> "2.9.38". The
      // real semver keeps rising 29.x/30.x so electron-updater ordering and
      // release tags are untouched; this is purely the user-facing number.
      // Old shells without global.__version fall back to the bare revision.
      const maj = +((globalThis.__version || '').split('.')[0]);
      const version = maj ? `${Math.floor(maj / 10)}.${maj % 10}.${webRev}` : String(webRev);
      return json(res, { version, autoUpdate: !!globalThis.__autoUpdate, bridgeRev: BRIDGE_REV,
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
      const { message, contact } = JSON.parse(await body(req) || '{}');
      await telemetry('/feedback', { message, contact });
      return json(res, { ok: !!TELEMETRY_URL });
    }
    if (url.pathname === '/api/log-fight' && req.method === 'POST') {
      // Compact per-fight report from the page → one JSON file on disk, kept to
      // the newest 100. Shell provides the dir (packaged app only; dev = no-op).
      const dir = globalThis.__fightLogsDir;
      if (!dir) return json(res, { ok: false });
      const rep = JSON.parse(await body(req) || 'null');
      if (!rep || typeof rep !== 'object') return json(res, { ok: false });
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
      // Operator banner → backend /broadcast (empty message clears it). The page
      // gates the button by character name; the backend's PING_KEY is the real auth.
      let message;
      try { ({ message } = JSON.parse(await body(req) || '{}')); } catch { return json(res, { ok: false }); }
      if (!TELEMETRY_URL || (message != null && typeof message !== 'string')) return json(res, { ok: false });
      try {
        const r = await fetch(`${TELEMETRY_URL}/broadcast`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pod-key': PING_KEY },
          body: JSON.stringify({ message: (message || '').slice(0, 500) }),
          signal: AbortSignal.timeout(10000),
        });
        return json(res, { ok: r.ok });
      } catch { return json(res, { ok: false }); }
    }
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const { level, message } = JSON.parse(await body(req) || '{}');
      telemetry('/log', { level, message });
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/feedback-list') {
      // Operator inbox: proxy the backend's feedback feed (key stays bridge-side).
      if (!TELEMETRY_URL) return json(res, []);
      try {
        const r = await fetch(`${TELEMETRY_URL}/feedback-recent`,
          { headers: { 'x-pod-key': PING_KEY }, signal: AbortSignal.timeout(10000) });
        return json(res, r.ok ? await r.json() : []);
      } catch { return json(res, []); }
    }
    if (url.pathname === '/api/roster-classes') {
      return json(res, await rosterClasses());
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
      // On-demand interface hot-pull: same sha-pinned fetch the shell does at
      // launch, but written next to the running bridge so static serving picks
      // the new files up immediately (the caller reloads its window). Changes
      // to server.mjs/actions.mjs themselves still need an app restart — the
      // running modules can't be re-imported.
      try {
        const g = async (u, j) => { const r = await fetch(u, { headers: { 'User-Agent': 'PathOfDust' } }); if (!r.ok) throw new Error(r.status); return j ? r.json() : r.text(); };
        const cur = await appVersion();
        const sha = (await g('https://api.github.com/repos/micaelmbsilva/PathOfDust_Desktop/commits/main', true)).sha;
        const base = `https://raw.githubusercontent.com/micaelmbsilva/PathOfDust_Desktop/${sha}`;
        const manifest = JSON.parse(await g(`${base}/version.json`));
        if (manifest.version <= cur) return json(res, { updated: false, version: cur });
        const files = await Promise.all(manifest.files.map(f => g(`${base}/${f}`).then(t => [f, t]))); // all fetched before writing
        for (const [f, t] of files) await writeFile(new URL('./' + f, import.meta.url), t);
        await writeFile(new URL('./version.json', import.meta.url), JSON.stringify(manifest));
        return json(res, { updated: true, version: manifest.version });
      } catch { return json(res, { updated: false, error: true }); }
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
      const p = PAGES[JSON.parse(await body(req) || '{}').page];
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
      const { endpoint, fields } = JSON.parse(await body(req));
      const r = await post(endpoint, fields || {});
      // Success-looking 302 to the login page = dead session; tell the UI apart
      // from a normal craft redirect so it can say "restart to re-login".
      if (r.ok && loginRedirect(r.location)) r.expired = true;
      return json(res, r);
    }
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = new URL('.' + p, ROOT);
    const data = await readFile(file);
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
const body = (req) => new Promise((resolve, reject) => {
  let b = '', n = 0;
  req.on('data', c => {
    n += c.length; // Buffer bytes, not decoded chars
    if (n > 2e6) { const e = new Error('body too large'); e.status = 413; req.destroy(); return reject(e); }
    b += c;
  });
  req.on('end', () => resolve(b));
  req.on('error', () => resolve(''));
});

// usage heartbeat: once ~after login, then every 30 min
setTimeout(ping, 20000);
setInterval(ping, 30 * 60000);
