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
  ssl: DB_URL.includes('.railway.internal') ? false : { rejectUnauthorized: false },
}) : null;

async function init() {
  if (!pool) { console.error('No DATABASE_URL set — DB routes will 503.'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS installs (
    id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
    version TEXT, archetype TEXT, level INT, data JSONB)`);
  await pool.query(`ALTER TABLE installs ADD COLUMN IF NOT EXISTS data JSONB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), install TEXT, version TEXT, level TEXT, message TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), install TEXT, version TEXT, message TEXT, contact TEXT)`);
  console.log('DB ready');
}

// async route wrapper — never hang; DB errors → 503 instead of a dead request
const h = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e.message); if (!res.headersSent) res.sendStatus(503); });

app.get('/', (_req, res) => res.type('text').send('Path of Dust telemetry — ok'));

app.post('/ping', h(async (req, res) => {
  if (!pool) return res.sendStatus(503);
  const { install, version, archetype, level, ...data } = req.body || {};
  if (!install) return res.sendStatus(400);
  await pool.query(
    `INSERT INTO installs (id, version, archetype, level, data) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET last_seen = now(), version = $2, archetype = $3, level = $4, data = $5`,
    [String(install).slice(0, 64), version || null, archetype || null,
     Number.isFinite(+level) ? +level : null, JSON.stringify(data)]);
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
  if (process.env.STATS_TOKEN && req.query.token !== process.env.STATS_TOKEN) return res.sendStatus(403);
  if (!pool) return res.sendStatus(503);
  const one = async (q) => (await pool.query(q)).rows;
  const num = async (q) => +(await one(q))[0].count;
  res.json({
    totalInstalls: await num(`SELECT count(*) FROM installs`),
    active24h: await num(`SELECT count(*) FROM installs WHERE last_seen > now() - interval '1 day'`),
    active7d: await num(`SELECT count(*) FROM installs WHERE last_seen > now() - interval '7 days'`),
    byClass: await one(`SELECT archetype, count(*)::int FROM installs GROUP BY archetype ORDER BY 2 DESC`),
    byVersion: await one(`SELECT version, count(*)::int FROM installs GROUP BY version ORDER BY 2 DESC`),
    levels: await one(`SELECT min(level), round(avg(level)) avg, max(level) FROM installs WHERE level IS NOT NULL`),
    recentSnapshots: await one(`SELECT id, last_seen, version, archetype, level, data FROM installs ORDER BY last_seen DESC LIMIT 50`),
    recentFeedback: await one(`SELECT ts, version, message, contact FROM feedback ORDER BY ts DESC LIMIT 50`),
    recentErrors: await one(`SELECT ts, version, message FROM logs WHERE level='error' ORDER BY ts DESC LIMIT 50`),
  });
}));

// Serve regardless of DB state so / always answers; init (and retry) in background.
const PORT = process.env.PORT || 8080; // domain routes to 8080
app.listen(PORT, () => console.log('telemetry up on', PORT));
init().catch((e) => console.error('DB init failed (will still serve):', e.message));
