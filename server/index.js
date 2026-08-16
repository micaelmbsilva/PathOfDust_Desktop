// Path of Dust — telemetry & feedback backend (deploy to Railway with a Postgres).
// Receives anonymous usage pings, app logs, and feedback/bug reports. No names,
// no PII — just a random install id + version + class/level + game stats.
//
// Env: DATABASE_URL (Railway Postgres), STATS_TOKEN (guards GET /stats), PORT.
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { // open receiver — the app posts from anywhere
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
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
  await pool.query(`UPDATE installs SET name = data->>'name' WHERE name IS NULL AND data ? 'name'`); // backfill from prior pings so old dupes collapse too
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
  console.log('DB ready');
}

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
  const name = data.name ? String(data.name).slice(0, 128) : null;
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

// Dashboard JSON — guarded by ?token=STATS_TOKEN
app.get('/stats', h(async (req, res) => {
  // Fail closed: without STATS_TOKEN configured this dump (install ids + full
  // JSONB incl. bags/currency) must not be public.
  if (!process.env.STATS_TOKEN || req.query.token !== process.env.STATS_TOKEN) return res.sendStatus(403);
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
    pool.query(`SELECT name, archetype, level, date_trunc('day', last_seen) AS last_seen, data->'stats' AS stats ${PUB}
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
  const W = `${PUB} AND archetype = $1`;
  const [meta, passives, mods] = await Promise.all([
    pool.query(`SELECT count(*)::int AS players, round(avg(level)) AS avg_level, max(level) AS max_level ${W}`, [a]),
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

// Private watchlist (OP interactions) — keyed, fail closed. SITE_KEY env gates
// it; the data lives outside public/ so the static server never exposes it.
app.get('/api/watchlist', (req, res) => {
  if (!process.env.SITE_KEY || req.query.key !== process.env.SITE_KEY) return res.sendStatus(403);
  res.sendFile(require('path').join(__dirname, 'watchlist.json'));
});

// Empirical affix rates for the advisor's t100 projection: average mod value per
// item tier, per affix type, across all scraped gear. Same key as the watchlist.
app.get('/api/affix-rates', h(async (req, res) => {
  if (!process.env.SITE_KEY || req.query.key !== process.env.SITE_KEY) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  const { rows } = await pool.query(`
    SELECT trim(regexp_replace(m->>'t', '[-+0-9.,%]+', ' ', 'g')) AS affix,
           round(avg((substring(m->>'t' from '([0-9]+\\.?[0-9]*)'))::numeric
                     / NULLIF((substring(it->>'tier' from '\\d+'))::int, 0)), 4) AS per_tier,
           count(*)::int AS samples
    FROM installs, jsonb_array_elements(data->'equipped') it, jsonb_array_elements(it->'mods') m
    WHERE data ? 'equipped' AND m->>'t' ~ '[0-9]' AND it->>'tier' ~ '\\d'
    GROUP BY 1 HAVING count(*) >= 3 ORDER BY 3 DESC`);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ rates: rows });
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
// its keys (stats/equipped/level) over the row's data, a later app ping replaces
// the row wholesale — so passives/currency from pings survive scrapes, and both
// paths keep the row current. SCRAPE=off disables.
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

function parseCharacter(text) {
  const name = strip((text.match(/<h1>([^<]*)<\/h1>/) || [])[1] || '');
  const archetype = strip((text.match(/class="role-badge[^"]*"[^>]*>([^<]*)</) || [])[1] || '');
  const stats = {};
  for (const m of text.matchAll(/class="stat-label"[^>]*>(.*?)<\/div>\s*<div class="stat-value"[^>]*>(.*?)<\/div>/gs)) {
    const k = strip(m[1]);
    if (k && !/^(Dust|Sand)$/i.test(k)) stats[k] = strip(m[2]); // currency stays out of public stats
  }
  const level = +String(stats.Level || '').replace(/\D/g, '') || null;
  const equipped = [];
  for (const chunk of text.split(/class="bag-row/)[0].split('class="gear-slot"').slice(1)) {
    const grab = (cls) => strip((chunk.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');
    equipped.push({
      slot: grab('gear-slot-label'), name: grab('gear-name'), tier: grab('gear-tier'),
      quality: grab('gear-quality'), primary: grab('gear-primary'),
      mods: [...chunk.matchAll(/class="mod-roll"([^>]*)>([^<]*)</g)]
        .map(m => ({ t: strip(m[2]), tip: strip((m[1].match(/data-tip="([^"]*)"/) || [])[1] || '') })),
      sacred: /gear-name-sacred/.test(chunk), krangled: /gear-name-locked/.test(chunk),
      implicit: strip((chunk.match(/class="gear-(?:sacred|unique)"[^>]*>([^<]*)</) || [])[1] || ''),
    });
  }
  return { name, archetype, level, stats, equipped };
}

// Public read-only tree page: nodes have no node_key, so key stays null; rank
// reads "2/4". Mirrors the app ping's passives shape.
function parsePassives(text) {
  const points = strip((text.match(/points-chip[^]*?<strong>([^<]+)<\/strong>/) || [])[1] || '');
  const nodes = [];
  for (const chunk of text.split('class="node ').slice(1)) {
    const head = chunk.slice(0, 1200);
    const grab = (cls) => strip((head.match(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`)) || [])[1] || '');
    const name = grab('node-name');
    if (!name || head.startsWith('node-root')) continue;
    nodes.push({ key: null, name, tier: grab('node-kind'), rank: grab('node-rank') });
  }
  return { points, nodes };
}

async function scrapeRoster() {
  if (!pool) return;
  try {
    const listing = await getPage('/characters');
    const slugs = [...new Set([...listing.matchAll(/href="\/characters\/([^"/]+)"/g)].map(m => m[1]))];
    if (!slugs.length) { console.error('roster scrape: no roster links — GAME_COOKIE missing or expired?'); return; }
    let ok = 0;
    for (const slug of slugs) {
      try {
        const c = parseCharacter(await getPage('/characters/' + encodeURIComponent(slug)));
        if (!c.name) continue;
        const id = 'web:' + slug.slice(0, 60);
        const data = { scraped: new Date().toISOString(), name: c.name, stats: c.stats, equipped: c.equipped };
        try {
          const p = parsePassives(await getPage('/characters/' + encodeURIComponent(slug) + '/passives'));
          if (p.nodes.length) data.passives = p;
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
  } catch (e) { console.error('roster scrape failed:', e.message); }
}
// ---- Wiki tree scrape --------------------------------------------------------
// Keeps the class trees + node effect text behind /passives.json current with
// the live game wiki (public page). Parser ported from wiki/scrape.mjs.
let wikiTrees = null;
const wstrip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, '')
  .replace(/\s+/g, ' ').trim();
function parseWiki(t) {
  const out = {};
  for (let block of t.split(/<details class="[^"]*wiki-archetype[^"]*">/).slice(1)) {
    block = block.split('</details>')[0];
    const summary = wstrip((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '');
    const name = summary.replace(/Melee|Ranged|Support/g, '').replace(/^[^A-Za-z]+/, '').trim();
    if (!name) continue;
    out[name] = {
      role: (block.match(/role-badge[^>]*>([^<]*)</) || [])[1] || '',
      root: wstrip((block.match(/wiki-root-desc[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ''),
      skills: block.split('<div class="wiki-skill">').slice(1).map((sk) => {
        const h3 = (sk.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || '';
        return {
          name: wstrip(h3.split('<span')[0]),
          max: (wstrip(h3).match(/max\s+([\d/]+)/) || [])[1] || '',
          text: wstrip((sk.split('<div class="wiki-spec">')[0].match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ''),
          specializations: sk.split('<div class="wiki-spec">').slice(1).map((sp) => {
            const h4 = (sp.match(/<h4>([\s\S]*?)<\/h4>/) || [])[1] || '';
            return {
              name: wstrip(h4.split('<span')[0]),
              max: (wstrip(h4).match(/max\s+([\d/]+)/) || [])[1] || '',
              text: wstrip((sp.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ''),
              modifiers: [...sp.matchAll(/<li><strong>([^<]*)<\/strong>\s*<span[^>]*>\(([^)]*)\)<\/span>\s*-?\s*([\s\S]*?)<\/li>/g)]
                .map((m) => ({ name: wstrip(m[1]), max: (m[2].match(/max\s+([\d/]+)/) || [])[1] || '', text: wstrip(m[3]) })),
            };
          }),
        };
      }),
    };
  }
  return out;
}
async function scrapeWiki() {
  try {
    const out = parseWiki(await getPage('/wiki'));
    const n = Object.keys(out).length;
    if (n >= 5) { wikiTrees = out; console.log('wiki scrape:', n, 'classes'); }
    else console.error('wiki scrape: only', n, 'classes parsed — markup changed? keeping previous');
  } catch (e) { console.error('wiki scrape failed:', e.message); }
}

if (process.env.SCRAPE !== 'off') {
  setTimeout(scrapeRoster, 60e3); // first pass shortly after boot, once DB init settled
  setInterval(scrapeRoster, 30 * 60e3);
  setTimeout(scrapeWiki, 20e3);
  setInterval(scrapeWiki, 6 * 3600e3); // trees change rarely
}

// Serve regardless of DB state so / always answers; init (and retry) in background.
const PORT = process.env.PORT || 8080; // domain routes to 8080
app.listen(PORT, () => console.log('telemetry up on', PORT));
init().catch((e) => console.error('DB init failed (will still serve):', e.message));
