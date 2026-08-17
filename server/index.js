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
// app (they poll GET /broadcast every minute). POST with x-pod-key (PING_KEY)
// sets it; empty/absent message clears it. Fail closed: no PING_KEY env, no posting.
// ponytail: in-memory — a Railway redeploy clears the message; re-post if needed.
let broadcast = null;
app.post('/broadcast', (req, res) => {
  if (!process.env.PING_KEY || req.get('x-pod-key') !== process.env.PING_KEY) return res.sendStatus(403);
  const message = (req.body || {}).message;
  broadcast = message ? { id: Date.now().toString(36), message: String(message).slice(0, 500), ts: new Date().toISOString() } : null;
  res.json(broadcast || { cleared: true });
});
app.get('/broadcast', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(broadcast || {}); });

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
// The newest investigation (if any) supersedes the hand-curated file: the model
// is given the current list and returns the full updated one, so there is always
// exactly one source of truth.
app.get('/api/watchlist', h(async (req, res) => {
  if (!process.env.SITE_KEY || req.query.key !== process.env.SITE_KEY) return res.sendStatus(403);
  const found = await latestInvestigation();
  if (found && arr(found.data.interactions).length) return res.json({ interactions: found.data.interactions });
  res.sendFile(require('path').join(__dirname, 'watchlist.json'));
}));

// Private inbox: user feedback + recent app errors, newest first. Same SITE_KEY
// gate as the watchlist — these carry install ids and contact handles.
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

// ---- Investigation ----------------------------------------------------------
// One keyed trigger pulls everything the game exposes (roster, wiki, patch notes),
// packs it with the observed-play aggregates into a dossier, and has Claude look
// for broken/OP interactions and patterns. The result replaces the watchlist and
// feeds the advisor's scoring. Manual only — a run costs real money.

const arr = (x) => Array.isArray(x) ? x : [];
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

// Kept small on purpose: the model gets derived aggregates plus a handful of full
// builds, not the whole DB. Everything here is already public on the site.
async function buildDossier() {
  const one = async (q, p) => (await pool.query(q, p)).rows;
  const [classes, passives, mods, rates, top] = await Promise.all([
    one(`SELECT archetype, count(*)::int AS players, round(avg(level)) AS avg_level, max(level) AS max_level
         ${PUB} GROUP BY archetype ORDER BY 2 DESC`),
    // jsonb_typeof guards: one row storing a non-array here would otherwise error
    // out the whole query. Row caps keep the prompt (and its cost) bounded.
    one(`SELECT archetype, left(n->>'name', 120) AS node, count(*)::int AS players,
                round(avg((substring(n->>'rank' from '^\\d+'))::int), 1) AS avg_rank
         FROM installs, jsonb_array_elements(data->'passives'->'nodes') n
         WHERE name IS NOT NULL AND data ? 'equipped'
           AND jsonb_typeof(data->'passives'->'nodes') = 'array' AND n->>'rank' ~ '^[1-9]'
         GROUP BY 1, 2 ORDER BY 1, 3 DESC LIMIT 600`),
    one(`SELECT archetype, left(trim(regexp_replace(m->>'t', '[-+0-9.,%]+', ' ', 'g')), 120) AS mod,
                count(DISTINCT id)::int AS players
         FROM installs, jsonb_array_elements(data->'equipped') it, jsonb_array_elements(it->'mods') m
         WHERE name IS NOT NULL AND jsonb_typeof(data->'equipped') = 'array'
           AND jsonb_typeof(it->'mods') = 'array' AND m->>'t' IS NOT NULL
         GROUP BY 1, 2 HAVING count(DISTINCT id) > 1 ORDER BY 1, 3 DESC LIMIT 600`),
    one(`SELECT left(trim(regexp_replace(m->>'t', '[-+0-9.,%]+', ' ', 'g')), 120) AS affix,
                round(avg((substring(m->>'t' from '([0-9]+\\.?[0-9]*)'))::numeric
                          / NULLIF((substring(it->>'tier' from '\\d+'))::int, 0)), 4) AS per_tier,
                count(*)::int AS samples
         FROM installs, jsonb_array_elements(data->'equipped') it, jsonb_array_elements(it->'mods') m
         WHERE jsonb_typeof(data->'equipped') = 'array' AND jsonb_typeof(it->'mods') = 'array'
           AND m->>'t' ~ '[0-9]' AND it->>'tier' ~ '\\d'
         GROUP BY 1 HAVING count(*) >= 3 ORDER BY 3 DESC LIMIT 300`),
    // Full loadouts for the highest-level players — the sharp end of the meta,
    // where a broken interaction shows up first.
    one(`SELECT name, archetype, level, data->'stats' AS stats, data->'equipped' AS equipped,
                data->'passives' AS passives ${PUB} ORDER BY level DESC NULLS LAST LIMIT 10`),
  ]);
  const current = await latestInvestigation();
  const dossier = {
    generated: new Date().toISOString(),
    wiki: wikiTrees,                              // class trees: skills, specs, modifiers
    patchNotes: arr(patchNotes).slice(0, 12),     // most recent dates — older ones are settled history
    observed: { classes, passives, mods, affixRates: rates, topBuilds: top },
    currentWatchlist: current ? current.data.interactions
      : JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'watchlist.json'), 'utf8')).interactions,
  };
  // Hard ceiling on what one run can cost. Well above the ~400KB a healthy
  // dossier weighs; if it is ever hit, something upstream has grown unbounded.
  const body = JSON.stringify(dossier);
  if (body.length > 2e6) throw new Error(`dossier too large (${body.length} bytes) — refusing to send`);
  return { dossier, body };
}

const SYSTEM = `You analyse a live Twitch idle-RPG ("Path of Dust") for the operator, who runs the community's stats site.

Your job: read everything you are given and find (a) broken or overpowered interactions and gear/tree/class combinations, and (b) patterns in how the game actually behaves that players would not get from the wiki. Findings feed two places: a watchlist page the operator reads, and a build advisor that scores classes against a player's actual gear.

Ground every finding in the dossier. Cite what it rests on in the evidence field — a wiki modifier, a patch note date, an affix rate, a pick rate, a specific top build. Prefer a mechanism you can trace over a hunch; if something is a suspicion, say so in the text rather than dropping it.

The dossier's currentWatchlist is the operator's existing list. Return the FULL updated list, not a diff: keep entries that still hold (edit their text when patch notes or data have moved them), drop entries a patch note has invalidated, and add what you have newly found. Say in the entry's text when a patch changed it.

Name classes exactly as the dossier's archetypes are spelled — the advisor matches on that string, so a paraphrase silently drops the finding.

For each interaction set rolls to the gear affix / stat names it leans on, using the dossier's own affix wording where possible, so the advisor can match them against a player's mods. Leave rolls empty when an interaction does not depend on gear.

Write for someone who plays this game daily: specific, concrete numbers, no hedging filler.`;

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'interactions', 'patterns'],
  properties: {
    summary: { type: 'string', description: 'What changed since the previous investigation, in a few sentences.' },
    interactions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'type', 'classes', 'text', 'impact', 'rolls', 'evidence'],
        properties: {
          title: { type: 'string' },
          type: { type: 'string', enum: ['combat', 'crafting', 'tree', 'economy', 'bug', 'synergy'] },
          classes: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          rolls: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
        },
      },
    },
    patterns: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'text', 'evidence'],
        properties: { title: { type: 'string' }, text: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
  },
};

async function initInvestigations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS investigations (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), model TEXT, data JSONB, usage JSONB)`);
}
async function latestInvestigation() {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(`SELECT id, ts, model, data, usage FROM investigations ORDER BY id DESC LIMIT 1`);
    return rows[0] || null;
  } catch { return null; } // table may not exist yet on a cold DB
}

// In-memory run state — the trigger returns immediately and the page polls.
// ponytail: single global run, no queue; a second trigger is refused while one runs.
let run = { status: 'idle', startedAt: null, finishedAt: null, step: null, error: null };

async function runInvestigation() {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  run.step = 'scraping game data';
  await Promise.all([scrapeRoster(), scrapeWiki(), scrapePatchNotes()]);
  run.step = 'building dossier';
  const { body } = await buildDossier();
  run.step = 'analysing';
  // Streamed: the answer is long and a non-streaming call this size risks an
  // HTTP timeout. Fallbacks on by default — a safety decline should not lose the run.
  const req = {
    model: ANTHROPIC_MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: FINDINGS_SCHEMA } },
    messages: [{ role: 'user', content: body }],
  };
  let message;
  try {
    message = await client.beta.messages.stream(req).finalMessage();
  } catch (e) {
    // Server-side fallback is a beta: if this account or model can't take it,
    // the analysis itself is still fine — drop the parameter and run plain.
    if (!/fallback/i.test(e.message || '')) throw e;
    console.error('retrying without server-side fallback:', e.message);
    const { betas, fallbacks, ...plain } = req;
    message = await client.messages.stream(plain).finalMessage();
  }
  if (message.stop_reason === 'refusal') throw new Error('model declined the request');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  await pool.query(`INSERT INTO investigations (model, data, usage) VALUES ($1,$2,$3)`,
    [message.model || ANTHROPIC_MODEL, JSON.stringify(data), JSON.stringify(message.usage || {})]);
  return data;
}

// Trigger + status share one keyed route: POST starts a run, GET reports on it
// and returns the newest findings.
app.post('/api/investigate', h(async (req, res) => {
  if (!process.env.SITE_KEY || req.query.key !== process.env.SITE_KEY) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (run.status === 'running') return res.status(409).json(run);
  // Cooldown, checked against the stored row so a redeploy (which clears the
  // in-memory state) can't be used to re-run a costly analysis back to back.
  // ?force=1 overrides when a rerun is genuinely wanted.
  const last = await latestInvestigation();
  const sinceMin = last ? (Date.now() - new Date(last.ts)) / 60000 : Infinity;
  if (sinceMin < 15 && req.query.force !== '1') {
    return res.status(429).json({ error: `last investigation ran ${Math.round(sinceMin)} min ago — add &force=1 to run anyway` });
  }
  run = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, step: 'starting', error: null };
  runInvestigation()
    .then(() => { run = { ...run, status: 'done', step: null, finishedAt: new Date().toISOString() }; })
    .catch((e) => {
      console.error('investigation failed:', e.message);
      run = { ...run, status: 'failed', step: null, error: e.message, finishedAt: new Date().toISOString() };
    });
  res.status(202).json(run);
}));

app.get('/api/investigate', h(async (req, res) => {
  if (!process.env.SITE_KEY || req.query.key !== process.env.SITE_KEY) return res.sendStatus(403);
  const found = await latestInvestigation();
  res.set('Cache-Control', 'no-store');
  res.json({
    run, configured: !!process.env.ANTHROPIC_API_KEY,
    latest: found && { ts: found.ts, model: found.model, usage: found.usage, ...found.data },
    patchNotes,
  });
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

// Advisor-only gear view: includes the bag (privacy-excluded from the public
// build endpoint), so recommendations can weigh owned-but-unworn items. Keyed.
app.get('/api/advisor-gear/:name', h(async (req, res) => {
  if (!process.env.SITE_KEY || req.query.key !== process.env.SITE_KEY) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  const { rows } = await pool.query(
    `SELECT data->'equipped' AS equipped, data->'bag' AS bag FROM installs
     WHERE name = $1 ORDER BY last_seen DESC LIMIT 1`, [String(req.params.name).slice(0, 128)]);
  if (!rows.length) return res.sendStatus(404);
  res.json(rows[0]);
}));

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
        const data = { scraped: new Date().toISOString(), name: c.name, stats: c.stats, equipped: c.equipped };
        try {
          const p = parsePassives(await getPage('/characters/' + encodeURIComponent(slug) + '/passives'));
          if (p.nodes.length) {
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

// ---- Patch notes -------------------------------------------------------------
// The game's /patch-notes page is public (no cookie needed) and is the only record
// of what the developer changed — the investigation leans on it to date findings
// and retire ones a patch has fixed. Markup: h2 = date, h3 = entry, li = bullets.
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

// Required as a module (test-parsers.js) — export the parsers and start nothing.
if (require.main !== module) { module.exports = { parsePatchNotes, parseCharacter, parsePassives, parseWiki }; return; }

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
