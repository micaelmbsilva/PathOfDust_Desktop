// Local bridge: serves our custom pages and holds the session so the browser
// (which can't touch the httpOnly cookie) can read our stats and fire actions.
// No deps. Run: node server.mjs   ->   http://localhost:8787
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { post, getAuthed } from './actions.mjs';
import { GAME_NAME, TELEMETRY_URL } from './config.mjs';

// Anonymous telemetry/feedback → the Railway backend. No-op if no URL set.
const INSTALL = process.env.INSTALL_ID || '';
const appVersion = async () => { try { return JSON.parse(await readFile(new URL('./version.json', import.meta.url), 'utf8')).version; } catch { return 0; } };
async function telemetry(pathname, extra) {
  if (!TELEMETRY_URL) return;
  try {
    await fetch(`${TELEMETRY_URL}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
        primary: it.primary, mods: it.mods, krangled: it.krangled, protected: it.protected });
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
  return { name, nav, stats, autoRepair, autoRepairTip, reforge };
}
const strip = (s) => s.replace(/<[^>]*>/g, '')
  .replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#?\w+;/g, '').trim();

// data-tip (the site's hover text) out of an element's attribute string.
const tipOf = (attrs) => strip((attrs.match(/data-tip="([^"]*)"/) || [])[1] || '');
// modifiers with their roll-% tooltip: [{ t: "+5 max hp", tip: "Roll: 30%" }]
const modsOf = (chunk) => [...chunk.matchAll(/class="mod-roll"([^>]*)>([^<]*)</g)]
  .map(m => ({ t: strip(m[2]), tip: tipOf(m[1]) }));
// the gear-quality element's tooltip (Perfect Quality etc.)
const qtipOf = (chunk) => tipOf((chunk.match(/class="gear-quality[^"]*"([^>]*)>/) || [])[1] || '');

// Scrape the bag (unequipped items) from the inventory page. Each item's id is
// the item_id its equip/disenchant forms carry; `protected` = the Keep checkbox.
async function bag(pageText) {
  const text = pageText ?? (await getAuthed('/inventory')).text; // reuse caller's fetch when given
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
      krangled: /gear-name-locked/.test(chunk),
      protected: /name="protect"[^>]*checked/.test(chunk),
    });
  }
  return { items };
}

// Full inventory: currencies, tokens, equipped gear, bag, and the craft form's
// item options + action buttons. Enough to drive a custom Bag page.
async function inventory() {
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
      krangled: /gear-name-locked/.test(chunk),
    });
  }

  // Craft form: item_a options + action buttons.
  const craftForm = (text.split('action="/craft"')[1] || '').split('</form>')[0];
  const selA = (craftForm.match(/<select name="item_a">([\s\S]*?)<\/select>/) || [])[1] || '';
  const options = [...selA.matchAll(/<option value="([^"]*)"[^>]*data-affixes="(\d+)"[^>]*data-tier="(\d+)"[^>]*data-quality="(\d+)"[^>]*data-perfect="(\d)"[^>]*>([^<]*)</g)]
    .map(m => ({ id: m[1], affixes: +m[2], tier: +m[3], quality: +m[4], perfect: m[5] === '1', label: strip(m[6]) }));
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
        recombine: /data-recombine/.test(a), polish: /data-polish/.test(a), reforge: /data-reforge/.test(a),
        dust: num('data-dust'), sand: num('data-sand'),
      };
    });
  const veilTip = tipOf((craftForm.match(/class="veil-check"([^>]*)>/) || [])[1] || '');

  // Pending veil/token choice: a veiled or token craft rolls 3 outcomes and the
  // site waits for the user to pick one (POST /craft/choose-veil, index 0-2).
  let veil = null;
  const vcRegion = (text.split('id="veil-choice"')[1] || '').split('bag-card')[0];
  if (vcRegion) {
    const title = strip((vcRegion.match(/<h2>([^<]*)<\/h2>/) || [])[1] || 'Choose your outcome');
    const options = [...vcRegion.matchAll(/name="index" value="(\d+)"[\s\S]*?<button[^>]*>([^<]*)</g)]
      .map(m => ({ index: +m[1], text: strip(m[2]).replace(/^Option \d+:\s*/, '') }));
    if (options.length) veil = { title, options };
  }

  return { dust, sand, tokens, equipped, bag: (await bag(text)).items, craft: { options, actions, veilTip }, veil };
}

// Passive tree: points chip, respec/save availability, and every node.
async function passives() {
  const { text } = await getAuthed('/passives');
  const points = strip((text.match(/points-chip[^]*?<strong>([^<]+)<\/strong>/) || [])[1] || '');
  const respecLabel = strip((text.match(/action="\/passives\/respec">\s*<button[^>]*>([^<]*)</) || [])[1] || 'Respec');
  const canSave = /action="\/passives\/save">\s*<button(?![^>]*disabled)/.test(text);
  // The live tree is an absolute canvas; grab its size + the SVG connectors
  // verbatim so we can reproduce the exact layout and dependency lines.
  const svg = (text.match(/<svg class="connectors"[\s\S]*?<\/svg>/) || [])[0] || '';
  const stage = { w: +(svg.match(/width="(\d+)"/) || [])[1] || 1180,
                  h: +(svg.match(/height="(\d+)"/) || [])[1] || 463 };
  const nodes = [];
  for (const chunk of text.split('class="node ').slice(1)) {
    const head = chunk.slice(0, chunk.indexOf('</form>') + 7);
    const key = (head.match(/name="node_key"\s+value="([^"]+)"/) || [])[1];
    if (!key) continue;
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
  return { points, respecLabel, canSave, stage, connectors: svg, nodes };
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    res.setHeader('Cache-Control', 'no-store'); // never cache app files — always serve the current (updated) version
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`window.GAME_NAME=${JSON.stringify(GAME_NAME)};`);
    }
    if (url.pathname === '/api/version') {
      let webRev = 0;
      try { webRev = JSON.parse(await readFile(new URL('./version.json', import.meta.url), 'utf8')).version; } catch {}
      // Displayed version = shell major.minor + interface revision in the patch
      // slot (e.g. shell 29.0.0 + interface 36 -> "29.0.36"), so silent interface
      // updates are visible without looking like an app update. Convention: shell
      // releases bump major/minor only, keeping the patch slot free for this.
      // Old shells without global.__version fall back to the bare revision.
      const semver = globalThis.__version;
      return json(res, { version: semver ? semver.replace(/\d+$/, String(webRev)) : String(webRev), autoUpdate: !!globalThis.__autoUpdate });
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
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const { level, message } = JSON.parse(await body(req) || '{}');
      telemetry('/log', { level, message });
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/me') {
      return json(res, await me());
    }
    if (url.pathname === '/api/bag') {
      return json(res, await bag());
    }
    if (url.pathname === '/api/inventory') {
      return json(res, await inventory());
    }
    if (url.pathname === '/api/passives') {
      return json(res, await passives());
    }
    if (url.pathname === '/api/raw') {
      // Raw page passthrough for parser debugging — allowlisted site pages only.
      const p = url.searchParams.get('path');
      if (!['/', '/inventory', '/passives'].includes(p)) { res.writeHead(400); return res.end('bad path'); }
      const { text } = await getAuthed(p);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const { endpoint, fields } = JSON.parse(await body(req));
      return json(res, await post(endpoint, fields || {}));
    }
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = new URL('.' + p, ROOT);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500);
    res.end(String(e.message || e));
  }
}).listen(PORT, () => console.log(`bridge on http://localhost:${PORT}`));

const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });

// usage heartbeat: once ~after login, then every 30 min
setTimeout(ping, 20000);
setInterval(ping, 30 * 60000);
