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
    pool.query(`SELECT name, archetype, level, date_trunc('day', last_seen) AS last_seen ${PUB}
                ORDER BY level DESC NULLS LAST, last_seen DESC LIMIT 200`),
    pool.query(`SELECT archetype, count(*)::int ${PUB} GROUP BY archetype ORDER BY 2 DESC`),
    pool.query(`SELECT (level/10)*10 AS bucket, count(*)::int ${PUB} AND level IS NOT NULL GROUP BY 1 ORDER BY 1`),
    pool.query(`SELECT count(*) ${PUB}`),
  ]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ players: players.rows, byClass: byClass.rows, levels: levels.rows, total: +total.rows[0].count });
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

// After all routes so nothing in public/ can shadow an API path; default etag
// caching so the shell revalidates on deploy. Serves public/index.html at /.
app.use(express.static(require('path').join(__dirname, 'public')));

// Serve regardless of DB state so / always answers; init (and retry) in background.
const PORT = process.env.PORT || 8080; // domain routes to 8080
app.listen(PORT, () => console.log('telemetry up on', PORT));
init().catch((e) => console.error('DB init failed (will still serve):', e.message));
