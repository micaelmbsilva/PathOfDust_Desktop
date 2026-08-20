// Path of Dust — telemetry & feedback backend (deploy to Railway with a Postgres).
// Receives anonymous usage pings, app logs, and feedback/bug reports. No names,
// no PII — just a random install id + version + class/level + game stats.
//
// Env: DATABASE_URL (Railway Postgres), STATS_TOKEN (guards GET /stats), PORT.
const express = require('express');
const { Pool } = require('pg');

const app = express();
// Pings, logs and feedback are small and arrive unauthenticated — keep their
// parse budget tight.
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { // open receiver — the app posts from anywhere
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-pod-owner');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Railway's internal Postgres URL (…​.railway.internal) is plain TCP, no SSL;
// its public/proxy URL needs SSL. Only enable SSL for the non-internal case.
const DB_URL = process.env.DATABASE_URL || '';
const pool = DB_URL ? new Pool({
  connectionString: DB_URL,
  ssl: /\.railway\.internal|localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
}) : null;

async function init() {
  if (!pool) { console.error('No DATABASE_URL set — DB routes will 503.'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS installs (
    id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
    version TEXT, archetype TEXT, level INT, data JSONB)`);
  await pool.query(`ALTER TABLE installs ADD COLUMN IF NOT EXISTS data JSONB`);
  await pool.query(`ALTER TABLE installs ADD COLUMN IF NOT EXISTS name TEXT`);
  // Backfill from prior pings so old dupes collapse too — but never resurrect a
  // misparsed welcome banner (the app can send it as a name before a character
  // exists; the nulled name below would otherwise come back every boot).
  await pool.query(`UPDATE installs SET name = data->>'name'
    WHERE name IS NULL AND data ? 'name' AND data->>'name' !~* '^welcome\\M'`);
  // App pings can carry the banner as a name — null it, keep the install row.
  await pool.query(`UPDATE installs SET name = NULL WHERE name ~* '^welcome\\M'`);
  // The public site keys on name — enforce uniqueness (pre-backfill rows and racing
  // pings can leave dupes): keep the freshest row per name, then lock it in.
  await pool.query(`DELETE FROM installs a USING installs b
    WHERE a.name IS NOT NULL AND a.name = b.name AND a.last_seen < b.last_seen`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS installs_name_uniq ON installs (name) WHERE name IS NOT NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), install TEXT, version TEXT, level TEXT, message TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), install TEXT, version TEXT, message TEXT, contact TEXT)`);
  // /stats orders these by ts — index so that stays cheap as they grow.
  // ponytail: no retention/pruning — volumes are tiny; add if tables ever matter.
  await pool.query(`CREATE INDEX IF NOT EXISTS logs_err_ts ON logs (ts DESC) WHERE level = 'error'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS feedback_ts ON feedback (ts DESC)`);
  // Scrape-created garbage rows (welcome banners parsed as characters) — clean up.
  await pool.query(`DELETE FROM installs WHERE id LIKE 'web:%' AND archetype IS NULL AND level IS NULL`);
  // Class tree layouts survive redeploys — the scrape only improves them.
  await initInvestigations();
  await pool.query(`CREATE TABLE IF NOT EXISTS tree_layouts (
    archetype TEXT PRIMARY KEY, data JSONB, updated TIMESTAMPTZ DEFAULT now())`);
  for (const r of (await pool.query(`SELECT archetype, data FROM tree_layouts`)).rows)
    treeLayouts[r.archetype] = r.data;
  console.log('DB ready');
}

const arr = (x) => Array.isArray(x) ? x : [];

// The operator key. Fails closed — an unset variable denies everyone. It travels
// in a header, never the query string: query strings land in proxy and access
// logs, and this is the privileged key. (The site key's ?key= is grandfathered;
// its pages are the shareable ones.)
const ownerOk = (req) => !!process.env.OWNER_KEY && req.get('x-pod-owner') === process.env.OWNER_KEY;

// async route wrapper — never hang; DB errors → 503 instead of a dead request
const h = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e.message); if (!res.headersSent) res.sendStatus(503); });

app.post('/ping', h(async (req, res) => {
  // Shared secret from the app (config.mjs PING_KEY): with the ladder public, an
  // unauthenticated /ping would let anyone overwrite a player's row by name.
  // ponytail: key ships inside the app so it's extractable; HMAC-signed pings if
  // someone determined ever griefs the ladder. Guard only /ping — /log and
  // /feedback stay open so old clients keep reporting.
  if (process.env.PING_KEY && req.get('x-pod-key') !== process.env.PING_KEY) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  const { install, version, archetype, level, ...data } = req.body || {};
  if (!install) return res.sendStatus(400);
  const id = String(install).slice(0, 64);
  // Shape-check at the boundary: every reader expands these with
  // jsonb_array_elements, which errors out on the whole query if a single stored
  // row holds a non-array here. Drop the field rather than store the wrong shape.
  const items = (list) => Array.isArray(list)
    ? list.filter((it) => it && typeof it === 'object')
        .map((it) => Array.isArray(it.mods) ? it : { ...it, mods: [] })
    : undefined;
  if (data.equipped !== undefined && !(data.equipped = items(data.equipped))) delete data.equipped;
  if (data.bag !== undefined && !(data.bag = items(data.bag))) delete data.bag;
  if (data.passives && !Array.isArray(data.passives.nodes)) delete data.passives;
  // The app can misparse the game's welcome banner as a character name before a
  // character exists — keep the install row but drop the bogus name (ladder is
  // name-keyed, so a null name also keeps the row off the public site).
  const rawName = data.name ? String(data.name).slice(0, 128) : null;
  const name = rawName && !/^welcome\b/i.test(rawName) ? rawName : null;
  const lvl = Number.isFinite(+level) ? +level : null;
  // One row per player: replace any prior row matching this install id OR name
  // (reinstalls get a fresh id but the same name), preserving the earliest
  // first_seen. Done in a txn so the delete + insert are atomic.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const where = `id = $1 OR ($2::text IS NOT NULL AND name = $2)`;
    const { rows } = await client.query(`SELECT min(first_seen) AS fs FROM installs WHERE ${where}`, [id, name]);
    await client.query(`DELETE FROM installs WHERE ${where}`, [id, name]);
    await client.query(
      `INSERT INTO installs (id, name, version, archetype, level, data, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now()), now())`,
      [id, name, version || null, archetype || null, lvl, JSON.stringify(data), rows[0] && rows[0].fs]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.sendStatus(204);
}));

app.post('/log', h(async (req, res) => {
  if (!pool) return res.sendStatus(503);
  const { install, version, level, message } = req.body || {};
  await pool.query(`INSERT INTO logs (install, version, level, message) VALUES ($1,$2,$3,$4)`,
    [(install || '').slice(0, 64), version || null, (level || 'info').slice(0, 16), (message || '').slice(0, 4000)]);
  res.sendStatus(204);
}));

app.post('/feedback', h(async (req, res) => {
  if (!pool) return res.sendStatus(503);
  const { install, version, message, contact } = req.body || {};
  if (!message) return res.sendStatus(400);
  await pool.query(`INSERT INTO feedback (install, version, message, contact) VALUES ($1,$2,$3,$4)`,
    [(install || '').slice(0, 64), version || null, message.slice(0, 4000), (contact || '').slice(0, 200)]);
  res.sendStatus(204);
}));

// Operator broadcast: one current message, shown as a banner by every running
// app (they poll GET /broadcast every minute). POST is gated on OWNER_KEY (the
// operator secret via x-pod-owner, ownerOk) — NOT the client-shipped PING_KEY,
// which is public and let anyone push a banner to every user (H3). Empty/absent
// message clears it. Fail closed: no OWNER_KEY env, no posting.
// ponytail: in-memory — a Railway redeploy clears the message; re-post if needed.
let broadcast = null;
app.post('/broadcast', (req, res) => {
  if (!ownerOk(req)) return res.sendStatus(403);
  const message = (req.body || {}).message;
  broadcast = message ? { id: Date.now().toString(36), message: String(message).slice(0, 500), ts: new Date().toISOString() } : null;
  res.json(broadcast || { cleared: true });
});
app.get('/broadcast', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(broadcast || {}); });

// Feedback feed for the in-app operator inbox — the data is messages users sent
// plus their optional contact line, so it's gated on OWNER_KEY (the operator
// secret) not the public PING_KEY, which would have let anyone read contacts
// (H3). Newest first, id-ordered so clients can diff "new since last seen".
app.get('/feedback-recent', h(async (req, res) => {
  if (!ownerOk(req)) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  res.set('Cache-Control', 'no-store');
  res.json((await pool.query(
    `SELECT id, ts, version, message, contact FROM feedback ORDER BY id DESC LIMIT 50`)).rows);
}));

// Operator inbox clear — deletes handled feedback up to and including ?upTo=<id>,
// so a message arriving mid-clear survives. Same OWNER_KEY gate as the feed.
app.post('/feedback-clear', h(async (req, res) => {
  if (!ownerOk(req)) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  const upTo = Number(req.query.upTo);
  if (!Number.isInteger(upTo) || upTo <= 0) return res.sendStatus(400);
  const { rowCount } = await pool.query(`DELETE FROM feedback WHERE id <= $1`, [upTo]);
  res.json({ cleared: rowCount });
}));

// Dashboard JSON — guarded by ?token=STATS_TOKEN
app.get('/stats', h(async (req, res) => {
  // Fail closed: without STATS_TOKEN configured this dump (install ids + full
  // JSONB incl. bags/currency) must not be public. The operator key (x-pod-owner)
  // is equivalent authority and saves the operator juggling a second secret.
  const tokenOk = process.env.STATS_TOKEN && req.query.token === process.env.STATS_TOKEN;
  if (!tokenOk && !ownerOk(req)) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  const one = async (q) => (await pool.query(q)).rows;
  const num = async (q) => +(await one(q))[0].count;
  const [totalInstalls, active24h, active7d, byClass, byVersion, levels, recentSnapshots, recentFeedback, recentErrors] = await Promise.all([
    num(`SELECT count(*) FROM installs`),
    num(`SELECT count(*) FROM installs WHERE last_seen > now() - interval '1 day'`),
    num(`SELECT count(*) FROM installs WHERE last_seen > now() - interval '7 days'`),
    one(`SELECT archetype, count(*)::int FROM installs GROUP BY archetype ORDER BY 2 DESC`),
    one(`SELECT version, count(*)::int FROM installs GROUP BY version ORDER BY 2 DESC`),
    one(`SELECT min(level), round(avg(level)) avg, max(level) FROM installs WHERE level IS NOT NULL`),
    one(`SELECT id, name, last_seen, version, archetype, level, data FROM installs ORDER BY last_seen DESC LIMIT 50`),
    one(`SELECT ts, version, message, contact FROM feedback ORDER BY ts DESC LIMIT 50`),
    one(`SELECT ts, version, message FROM logs WHERE level='error' ORDER BY ts DESC LIMIT 50`),
  ]);
  res.json({ totalInstalls, active24h, active7d, byClass, byVersion, levels, recentSnapshots, recentFeedback, recentErrors });
}));

// ---- Public site (poe.ninja-style ladder) ----------------------------------
// Public rows key on name only — the install id is the /ping upsert key and must
// never leave the server. last_seen is coarsened to the day.

const PUB = `FROM installs WHERE name IS NOT NULL AND data ? 'equipped'`;

app.get('/api/ladder', h(async (_req, res) => {
  if (!pool) return res.sendStatus(503);
  const [players, byClass, levels, total] = await Promise.all([
    // Rare gear rides along with the ladder rows (the board is the same players,
    // different columns). "Rare" = a unique affix from the Unique Shard craft
    // (Celestial Shard merged into it 2026-08-19), read off the gold implicit
    // line rather than the item's name class:
    // the game's item_name_class picks locked > sacred > unique, so a Sacred or
    // Krangled item carrying one never gets the gear-name-unique class. Sacred and
    // krangled bases themselves are craftable, so they don't count as rare.
    // Equipped + bag — both are public on the game's own character page. Held
    // shard tokens (unspent uniques) come from app pings only; the game shows them
    // on the owner's dashboard, not on public pages. jsonb_typeof guards every
    // array: one row with the wrong shape would otherwise error the whole query.
    pool.query(`SELECT name, archetype, level, date_trunc('day', last_seen) AS last_seen, data->'stats' AS stats,
                  (SELECT jsonb_agg(u) FROM (
                     SELECT split_part(regexp_replace(im->>'t', '^[^A-Za-z]+', ''), ':', 1) AS affix, count(*)::int AS n
                     FROM jsonb_array_elements(
                            (CASE WHEN jsonb_typeof(data->'equipped') = 'array' THEN data->'equipped' ELSE '[]'::jsonb END) ||
                            (CASE WHEN jsonb_typeof(data->'bag') = 'array' THEN data->'bag' ELSE '[]'::jsonb END)) it,
                          jsonb_array_elements(CASE WHEN jsonb_typeof(it->'implicits') = 'array' THEN it->'implicits' ELSE '[]'::jsonb END) im
                     WHERE im->'gold' = 'true'::jsonb AND im->>'t' ~ '[A-Za-z]'
                     GROUP BY 1) u) AS uniques,
                  (SELECT jsonb_agg(t) FROM jsonb_array_elements(
                            CASE WHEN jsonb_typeof(data->'tokens') = 'array' THEN data->'tokens' ELSE '[]'::jsonb END) t
                    WHERE t #>> '{}' ~ 'Shard') AS shards
                ${PUB}
                ORDER BY level DESC NULLS LAST, last_seen DESC LIMIT 200`),
    pool.query(`SELECT archetype, count(*)::int ${PUB} GROUP BY archetype ORDER BY 2 DESC`),
    pool.query(`SELECT (level/10)*10 AS bucket, count(*)::int ${PUB} AND level IS NOT NULL GROUP BY 1 ORDER BY 1`),
    pool.query(`SELECT count(*) ${PUB}`),
  ]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ players: players.rows, byClass: byClass.rows, levels: levels.rows, total: +total.rows[0].count });
}));

// Per-class meta: what this class's players actually run. Pick rates over the
// public population; numeric casts are regex-guarded since JSONB values are
// client-supplied. ponytail: unweighted by level — small playerbase; weight by
// top players if the meta ever gets noisy.
app.get('/api/class/:archetype', h(async (req, res) => {
  if (!pool) return res.sendStatus(503);
  const a = String(req.params.archetype).slice(0, 64);
  // No recency filter: the game roster gives no last-seen, and most players don't
  // run the app, so we have no reliable activity signal for them — assume alive
  // rather than drop a possibly-active player from the meta.
  const W = `${PUB} AND archetype = $1`;
  const [meta, passives, mods] = await Promise.all([
    pool.query(`SELECT count(*)::int AS players, round(avg(level)) AS avg_level, max(level) AS max_level,
                       (SELECT count(*)::int ${PUB}) AS total ${W}`, [a]),
    // Only allocated nodes count as picks (rank "2/4" or "2"; "0/4" = unallocated).
    pool.query(`SELECT n->>'name' AS name, count(*)::int AS players,
                       max(CASE WHEN n->>'tier' ~ '\\d' THEN (substring(n->>'tier' from '\\d+'))::int END) AS tier,
                       round(avg((substring(n->>'rank' from '^\\d+'))::int), 1) AS avg_rank
                ${W.replace('FROM installs', `FROM installs, jsonb_array_elements(data->'passives'->'nodes') n`)}
                AND n->>'name' IS NOT NULL AND n->>'rank' ~ '^[1-9]' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`, [a]),
    // Mods grouped by TYPE ("+55% crit chance" and "+40% crit chance" are the
    // same affix at different rolls) — strip the numeric part before grouping.
    pool.query(`SELECT trim(regexp_replace(m->>'t', '[-+0-9.,%]+', ' ', 'g')) AS mod, count(DISTINCT id)::int AS players
                ${W.replace('FROM installs', `FROM installs, jsonb_array_elements(data->'equipped') it, jsonb_array_elements(it->'mods') m`)}
                AND m->>'t' IS NOT NULL GROUP BY 1 HAVING trim(regexp_replace(m->>'t', '[-+0-9.,%]+', ' ', 'g')) <> ''
                ORDER BY 2 DESC, 1 LIMIT 15`, [a]),
  ]);
  if (!meta.rows[0].players) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ archetype: a, ...meta.rows[0], passives: passives.rows, mods: mods.rows });
}));

app.get('/api/build/:name', h(async (req, res) => {
  if (!pool) return res.sendStatus(503);
  // Whitelist in SQL — id, bag, and currency never leave the DB.
  const { rows } = await pool.query(
    `SELECT name, archetype, level, date_trunc('day', last_seen) AS last_seen,
            data->'stats' AS stats, data->'equipped' AS equipped, data->'passives' AS passives
     FROM installs WHERE name = $1 ORDER BY last_seen DESC LIMIT 1`, [String(req.params.name).slice(0, 128)]);
  if (!rows.length) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(rows[0]);
}));

// Private inbox: user feedback + recent app errors, newest first. Owner-only —
// these carry install ids and contact handles.
app.get('/api/feedback', h(async (req, res) => {
  if (!process.env.SITE_KEY || req.query.key !== process.env.SITE_KEY) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  res.set('Cache-Control', 'no-store');
  // ?since=<id> — badge poll: just the unread count, no messages over the wire.
  if (req.query.since != null) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM feedback WHERE id > $1`,
      [+req.query.since || 0]);
    return res.json({ unread: rows[0].n });
  }
  const [feedback, errors] = await Promise.all([
    pool.query(`SELECT id, ts, install, version, message, contact FROM feedback ORDER BY id DESC LIMIT 200`),
    pool.query(`SELECT id, ts, install, version, message FROM logs WHERE level = 'error' ORDER BY id DESC LIMIT 100`),
  ]);
  res.json({ feedback: feedback.rows, errors: errors.rows });
}));

// Freshness watermark for the site footer: deploy identity + when data last moved.
const STARTED = new Date().toISOString();
let lastScrapeAt = null;
let appRev = null; // the app's interface revision (version.json at repo root)
try { appRev = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'version.json'), 'utf8')).version; } catch {}
app.get('/api/meta', h(async (_req, res) => {
  const dbLatest = pool ? (await pool.query(`SELECT max(last_seen) AS m FROM installs`)).rows[0].m : null;
  res.json({
    rev: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev', appRev,
    deployed: STARTED, lastScrape: lastScrapeAt, dbLatest,
  });
}));

// Freshly scraped class trees win over the static public/passives.json snapshot
// (which stays as the fallback until the first wiki scrape lands).
app.get('/passives.json', (_req, res, next) => {
  if (!wikiTrees) return next();
  res.set('Cache-Control', 'public, max-age=300');
  res.json(wikiTrees);
});

// After all routes so nothing in public/ can shadow an API path; default etag
// caching so the shell revalidates on deploy. Serves public/index.html at /.
app.use(express.static(require('path').join(__dirname, 'public')));

// ---- Periodic roster scrape --------------------------------------------------
// The game's /characters pages are public; every 30 min we refresh each roster
// character into installs, keyed by name. Freshest writer wins: a scrape merges
// its keys (stats/equipped/level/passives) over the row's data, a later app ping
// replaces the row wholesale — currency/tokens (ping-only keys the scrape never
// sets) survive the merge. A scrape whose passives sub-page parses empty leaves
// passives unset, so the row keeps its previous passives. SCRAPE=off disables.
const GAME_URL = process.env.GAME_URL || 'https://adventure.lokati.net';
const strip = (s) => String(s).replace(/<[^>]*>/g, '').replace(/&middot;/g, '·').replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#?\w+;/g, '').trim();
const getPage = async (p) => {
  // Character pages sit behind the game's Twitch login — GAME_COOKIE holds the
  // operator's 'adv_session=…' cookie (Railway env; refresh when it expires,
  // currently ~monthly). Without it the site serves its login page and the
  // scrape no-ops with a log line.
  const headers = process.env.GAME_COOKIE ? { cookie: process.env.GAME_COOKIE } : {};
  const r = await fetch(GAME_URL + p, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.text();
};

const grabIn = (chunk, cls) => strip((chunk.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');

function parseCharacter(text) {
  const name = strip((text.match(/<h1>([^<]*)<\/h1>/) || [])[1] || '');
  const archetype = strip((text.match(/class="role-badge[^"]*"[^>]*>([^<]*)</) || [])[1] || '');
  const stats = {};
  for (const m of text.matchAll(/class="stat-label"[^>]*>(.*?)<\/div>\s*<div class="stat-value"[^>]*>(.*?)<\/div>/gs)) {
    const k = strip(m[1]);
    if (k && !/^(Divine )?(Dust|Sand)$/i.test(k)) stats[k] = strip(m[2]); // currency stays out of public stats
  }
  const level = +String(stats.Level || '').replace(/\D/g, '') || null;
  // The character page draws Gear and Bag with identical gear-slot markup; the
  // bag-row wrapper is the divider. Bag items are public on the game site, and
  // uniques sitting unworn still count as owned on the ladder's rare-gear board.
  const itemOf = (chunk) => ({
    slot: grabIn(chunk, 'gear-slot-label'), name: grabIn(chunk, 'gear-name'), tier: grabIn(chunk, 'gear-tier'),
    quality: grabIn(chunk, 'gear-quality'), primary: grabIn(chunk, 'gear-primary'),
    mods: [...chunk.matchAll(/class="mod-roll"([^>]*)>([^<]*)</g)]
      .map(m => ({ t: strip(m[2]), tip: strip((m[1].match(/data-tip="([^"]*)"/) || [])[1] || '') })),
    sacred: /gear-name-sacred/.test(chunk), krangled: /gear-name-locked/.test(chunk),
    // The site's item_name_class picks locked > sacred > unique, so a Sacred or
    // Krangled item with a Unique Shard affix carries no
    // gear-name-unique class — the affix line is the only reliable marker.
    unique: /class="gear-unique"/.test(chunk),
    // Sacred and unique (Unique Shard) implicits can BOTH be on one item —
    // the old single-match regex dropped the unique line. Same parse as
    // implicitsOf in ../server.mjs (separate deploy, so a duplicated one-liner
    // rather than an ESM import of a module that opens the bridge listener).
    implicits: [...chunk.matchAll(/class="gear-(sacred|unique)"[^>]*>([^<]*)</g)]
      .map(m => ({ t: strip(m[2]), gold: m[1] === 'unique' })).filter(x => x.t),
  });
  const chunks = (region) => region.split('class="gear-slot"').slice(1).map(itemOf);
  const [gearRegion, ...bagRegions] = text.split(/class="bag-row/);
  const equipped = chunks(gearRegion);
  const bag = bagRegions.flatMap(chunks);
  return { name, archetype, level, stats, equipped, bag };
}

// Public read-only tree page: nodes have no node_key, so key stays null; rank
// reads "2/4". Mirrors the app ping's passives shape. Also captures the page's
// absolute layout (node x/y/w + connector lines + stage size) so the site can
// draw the tree exactly like the game does — the layout is per-class static.
function parsePassives(text) {
  const points = strip((text.match(/points-chip[^]*?<strong>([^<]+)<\/strong>/) || [])[1] || '');
  const nodes = [];
  const layoutNodes = [];
  for (const chunk of text.split('class="node ').slice(1)) {
    const head = chunk.slice(0, 1600);
    const grab = (cls) => strip((head.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');
    const rawName = strip((head.match(/class="node-name[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    // "(inactive)" arrives as a nested span inside node-name — strip it into a flag
    const dead = /\(inactive\)/i.test(rawName) || /node--inactive/.test(head);
    const name = rawName.replace(/\s*\(inactive\)\s*/i, ' ').replace(/\s+/g, ' ').trim();
    const root = head.startsWith('node-root');
    if (!name && !root) continue;
    if (!root) nodes.push({ key: null, name, tier: grab('node-kind'), rank: grab('node-rank') });
    layoutNodes.push({
      name, dead, kind: root ? 'root' : (head.match(/^node-(skill|spec|mod)/) || [, 'skill'])[1],
      desc: strip((head.match(/data-tip="([^"]*)"/) || [])[1] || ''),
      max: +((grab('node-rank').match(/\/(\d+)/) || [])[1] || 0),
      x: +(head.match(/left:\s*([\d.]+)px/) || [])[1] || 0,
      y: +(head.match(/top:\s*([\d.]+)px/) || [])[1] || 0,
      w: +(head.match(/width:\s*([\d.]+)px/) || [])[1] || 140,
    });
  }
  const svg = (text.match(/<svg class="connectors"[\s\S]*?<\/svg>/) || [])[0] || '';
  const layout = {
    w: +(svg.match(/width="([\d.]+)"/) || [])[1] || 1180,
    h: +(svg.match(/height="([\d.]+)"/) || [])[1] || 463,
    nodes: layoutNodes,
    // lines parsed to plain numbers server-side — never inject scraped markup
    edges: [...svg.matchAll(/x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
      .map(m => ({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] })),
  };
  return { points, nodes, layout };
}

// Per-class tree layouts, refreshed by the roster scrape (same tree for every
// member of a class). In-memory — repopulated a couple of minutes after boot.
const treeLayouts = {};
app.get('/api/tree/:archetype', (req, res) => {
  const t = treeLayouts[String(req.params.archetype).slice(0, 64)];
  if (!t) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=300');
  res.json(t);
});

async function scrapeRoster() {
  if (!pool) return;
  try {
    // Re-run the garbage cleanup each cycle: a rolling deploy's old container can
    // re-insert a banner row after the new container's init already cleaned it.
    await pool.query(`DELETE FROM installs WHERE id LIKE 'web:%' AND archetype IS NULL AND level IS NULL`);
    await pool.query(`UPDATE installs SET name = NULL WHERE name ~* '^welcome\\M'`);
    const listing = await getPage('/characters');
    const slugs = [...new Set([...listing.matchAll(/href="\/characters\/([^"/]+)"/g)].map(m => m[1]))];
    if (!slugs.length) { console.error('roster scrape: no roster links — GAME_COOKIE missing or expired?'); return; }
    let ok = 0;
    for (const slug of slugs) {
      try {
        const c = parseCharacter(await getPage('/characters/' + encodeURIComponent(slug)));
        // Not a character sheet (onboarding/banner pages have an h1 too) — skip.
        if (!c.name || (!c.archetype && !c.level) || /^welcome\b/i.test(c.name)) continue;
        const id = 'web:' + slug.slice(0, 60);
        const data = { scraped: new Date().toISOString(), name: c.name, stats: c.stats, equipped: c.equipped, bag: c.bag };
        try {
          const p = parsePassives(await getPage('/characters/' + encodeURIComponent(slug) + '/passives'));
          if (!p.nodes.length) {
            // Main page scraped fine but the passives sub-page parsed empty — the
            // merge below keeps this char's OLD passives, so the popular-passives
            // meta lags for them until a good parse lands. Surface it, don't hide it.
            console.error('scrape passives', slug + ': 0 nodes parsed — keeping stale passives');
          } else {
            data.passives = { points: p.points, nodes: p.nodes };
            // Keep the richest SINGLE page per class. Never merge coordinates
            // across pages — the game re-lays the canvas out per reveal state,
            // so different players' pages use different coordinate spaces.
            if (c.archetype && p.layout.nodes.length > 3
              && (!treeLayouts[c.archetype] || p.layout.nodes.length > treeLayouts[c.archetype].nodes.length)) {
              try { // save first — a failed save keeps memory unset so the next cycle retries
                await pool.query(`INSERT INTO tree_layouts (archetype, data, updated) VALUES ($1, $2, now())
                                  ON CONFLICT (archetype) DO UPDATE SET data = $2, updated = now()`,
                  [c.archetype, JSON.stringify(p.layout)]);
                treeLayouts[c.archetype] = p.layout;
              } catch (e) { console.error('layout save:', e.message); }
            }
          }
        } catch (e) { console.error('scrape passives', slug + ':', e.message); }
        await pool.query(`DELETE FROM installs WHERE id = $1 AND name <> $2`, [id, c.name]); // renamed char
        await pool.query(
          `INSERT INTO installs (id, name, archetype, level, data) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (name) WHERE name IS NOT NULL DO UPDATE SET
             archetype = COALESCE(EXCLUDED.archetype, installs.archetype),
             level = COALESCE(EXCLUDED.level, installs.level),
             last_seen = now(),
             data = installs.data || EXCLUDED.data`,
          [id, c.name.slice(0, 128), c.archetype || null, c.level, JSON.stringify(data)]);
        ok++;
      } catch (e) { console.error('scrape', slug + ':', e.message); }
      await new Promise((r) => setTimeout(r, 500)); // be polite to the game server
    }
    console.log('roster scrape:', ok, '/', slugs.length);
    if (ok) lastScrapeAt = new Date().toISOString();
  } catch (e) { console.error('roster scrape failed:', e.message); }
}
// ---- Wiki tree scrape --------------------------------------------------------
// Keeps the class trees + node effect text behind /passives.json current with
// the live game wiki (public page). Parser ported from wiki/scrape.mjs.
let wikiTrees = null;
const wstrip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, '')
  .replace(/\s+/g, ' ').trim();
// The wiki renders each class as the game's own node graph (it stopped being a
// bullet list on 2026-08-17). Rows sit at fixed depths — root, skill, spec, mod —
// and a child is horizontally centred under its parent, so nearest-x re-creates
// the hierarchy without needing the SVG connectors. Output shape is unchanged:
// the site's class pages read skills[].specializations[].modifiers[].
function parseWikiNodes(block) {
  const nodes = [];
  for (const chunk of block.split('class="node ').slice(1)) {
    const head = chunk.slice(0, 1600);
    const rank = wstrip((head.match(/class="node-rank[^"]*"[^>]*>([^<]*)</) || [])[1] || '');
    nodes.push({
      kind: (head.match(/^node-(\w+)/) || [, ''])[1],
      name: wstrip((head.match(/class="node-name[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '')
        .replace(/\s*\(inactive\)\s*/i, ' ').trim(),
      max: rank,
      text: wstrip((head.match(/data-tip="([^"]*)"/) || [])[1] || ''),
      x: +(head.match(/left:\s*([\d.]+)px/) || [])[1] || 0,
    });
  }
  return nodes;
}
function parseWiki(t) {
  const out = {};
  for (let block of t.split(/<details class="[^"]*wiki-archetype[^"]*">/).slice(1)) {
    block = block.split('</details>')[0];
    const summary = wstrip((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '');
    const name = summary.replace(/Melee|Ranged|Support/g, '').replace(/^[^A-Za-z]+/, '').trim();
    if (!name) continue;
    const nodes = parseWikiNodes(block).filter((n) => n.name);
    const of = (kind) => nodes.filter((n) => n.kind === kind);
    // Nearest parent by horizontal position; ties go to the first, which keeps
    // the order stable when a class has an even number of children.
    const nearest = (child, parents) => parents.reduce((best, p) =>
      !best || Math.abs(p.x - child.x) < Math.abs(best.x - child.x) ? p : best, null);
    const skills = of('skill').map((s) => ({ ...s, specializations: [] }));
    const specs = of('spec').map((s) => ({ ...s, modifiers: [] }));
    for (const spec of specs) {
      const parent = nearest(spec, skills);
      if (parent) parent.specializations.push(spec);
    }
    for (const mod of of('mod')) {
      const parent = nearest(mod, specs);
      if (parent) parent.modifiers.push({ name: mod.name, max: mod.max, text: mod.text });
    }
    const clean = ({ x, kind, ...rest }) => rest; // drop layout-only fields
    out[name] = {
      role: (block.match(/role-badge[^>]*>([^<]*)</) || [])[1] || '',
      // The root node's tooltip is the same text the old wiki-root-desc carried.
      root: wstrip((block.match(/wiki-root-desc[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '')
        || (of('root')[0] || {}).text || '',
      skills: skills.map((s) => ({
        ...clean(s),
        specializations: s.specializations.map((sp) => ({
          ...clean(sp), modifiers: sp.modifiers,
        })),
      })),
    };
  }
  return out;
}
async function scrapeWiki() {
  try {
    // The wiki became a multi-page docs site on 2026-08-19: /wiki is now just an
    // index of links and carries no class markup at all, so this scrape had been
    // silently parsing zero classes and falling back to the static passives.json
    // on every run. The trees live on their own page now.
    const out = parseWiki(await getPage('/wiki/passives'));
    const n = Object.keys(out).length;
    // Counting classes alone is not enough: the 2026-08-17 redesign swapped the
    // bullet-list markup for node graphs, so every class still parsed — with
    // zero skills — and that empty result overwrote the static
    // public/passives.json fallback, emptying the site's tree browser. Accept a
    // parse only when EVERY class carries skills and the modifier count is in
    // the right order of magnitude, so a partial parse can't replace good data.
    const per = Object.values(out).map((c) => arr(c.skills).length);
    const mods = Object.values(out).reduce((s, c) => s + arr(c.skills)
      .reduce((k, sk) => k + arr(sk.specializations).reduce((m, sp) => m + arr(sp.modifiers).length, 0), 0), 0);
    if (n >= 5 && per.every((k) => k > 0) && mods >= 100) {
      wikiTrees = out;
      console.log('wiki scrape:', n, 'classes,', per.reduce((a, b) => a + b, 0), 'skills,', mods, 'modifiers');
    } else {
      console.error(`wiki scrape: ${n} classes, skills per class [${per}], ${mods} modifiers —`,
        'markup changed? keeping the previous trees (or the static passives.json fallback)');
    }
  } catch (e) { console.error('wiki scrape failed:', e.message); }
}

// ---- Patch notes -------------------------------------------------------------
// The game's /patch-notes page is public (no cookie needed) and is the only record
// of what the developer changed, served on to anyone who wants to date a change.
// Markup: h2 = date, h3 = entry, li = bullets.
let patchNotes = null;
function parsePatchNotes(t) {
  const out = [];
  for (const block of t.split('<h2>').slice(1)) {
    const date = wstrip(block.split('</h2>')[0]);
    const entries = block.split('<h3>').slice(1).map((chunk) => {
      const body = chunk.split('</h3>')[1] || '';
      const bullets = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => wstrip(m[1]));
      return {
        title: wstrip(chunk.split('</h3>')[0]),
        text: bullets.length ? bullets.join(' • ')
          : wstrip((body.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ''),
      };
    }).filter((e) => e.title);
    if (date && entries.length) out.push({ date, entries });
  }
  return out;
}
async function scrapePatchNotes() {
  try {
    const out = parsePatchNotes(await getPage('/patch-notes'));
    if (out.length) { patchNotes = out; console.log('patch notes:', out.length, 'dates'); }
    else console.error('patch notes: nothing parsed — markup changed? keeping previous');
  } catch (e) { console.error('patch notes scrape failed:', e.message); }
}
app.get('/api/patch-notes', (_req, res) => {
  if (!patchNotes) return res.sendStatus(503);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ dates: patchNotes });
});

// Required as a module (test-server.js) — export the pure bits, start nothing.
if (require.main !== module) {
  module.exports = { parsePatchNotes, parseCharacter, parsePassives, parseWiki };
  return;
}

if (process.env.SCRAPE !== 'off') {
  setTimeout(scrapeRoster, 60e3); // first pass shortly after boot, once DB init settled
  setInterval(scrapeRoster, 30 * 60e3);
  setTimeout(scrapeWiki, 20e3);
  setInterval(scrapeWiki, 6 * 3600e3); // trees change rarely
  setTimeout(scrapePatchNotes, 25e3);
  setInterval(scrapePatchNotes, 6 * 3600e3);
}

// Serve regardless of DB state so / always answers; init (and retry) in background.
const PORT = process.env.PORT || 8080; // domain routes to 8080
app.listen(PORT, () => console.log('telemetry up on', PORT));
init().catch((e) => console.error('DB init failed (will still serve):', e.message));
