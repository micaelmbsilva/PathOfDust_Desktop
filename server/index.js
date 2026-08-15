// Path of Dust — telemetry & feedback backend (deploy to Railway with a Postgres).
// Receives anonymous usage pings, app logs, and feedback/bug reports. No names,
// no PII — just a random install id + version + class/level.
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS installs (
    id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
    version TEXT, archetype TEXT, level INT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), install TEXT, version TEXT, level TEXT, message TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), install TEXT, version TEXT, message TEXT, contact TEXT)`);
}

app.get('/', (_req, res) => res.type('text').send('Path of Dust telemetry — ok'));

app.post('/ping', async (req, res) => {
  const { install, version, archetype, level } = req.body || {};
  if (!install) return res.sendStatus(400);
  await pool.query(
    `INSERT INTO installs (id, version, archetype, level) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET last_seen = now(), version = $2, archetype = $3, level = $4`,
    [String(install).slice(0, 64), version || null, archetype || null, Number.isFinite(+level) ? +level : null]);
  res.sendStatus(204);
});

app.post('/log', async (req, res) => {
  const { install, version, level, message } = req.body || {};
  await pool.query(`INSERT INTO logs (install, version, level, message) VALUES ($1,$2,$3,$4)`,
    [(install || '').slice(0, 64), version || null, (level || 'info').slice(0, 16), (message || '').slice(0, 4000)]);
  res.sendStatus(204);
});

app.post('/feedback', async (req, res) => {
  const { install, version, message, contact } = req.body || {};
  if (!message) return res.sendStatus(400);
  await pool.query(`INSERT INTO feedback (install, version, message, contact) VALUES ($1,$2,$3,$4)`,
    [(install || '').slice(0, 64), version || null, message.slice(0, 4000), (contact || '').slice(0, 200)]);
  res.sendStatus(204);
});

// Dashboard JSON — guarded by ?token=STATS_TOKEN
app.get('/stats', async (req, res) => {
  if (process.env.STATS_TOKEN && req.query.token !== process.env.STATS_TOKEN) return res.sendStatus(403);
  const one = async (q) => (await pool.query(q)).rows;
  const num = async (q) => +(await one(q))[0].count;
  res.json({
    totalInstalls: await num(`SELECT count(*) FROM installs`),
    active24h: await num(`SELECT count(*) FROM installs WHERE last_seen > now() - interval '1 day'`),
    active7d: await num(`SELECT count(*) FROM installs WHERE last_seen > now() - interval '7 days'`),
    byClass: await one(`SELECT archetype, count(*)::int FROM installs GROUP BY archetype ORDER BY 2 DESC`),
    byVersion: await one(`SELECT version, count(*)::int FROM installs GROUP BY version ORDER BY 2 DESC`),
    levels: await one(`SELECT min(level), round(avg(level)) avg, max(level) FROM installs WHERE level IS NOT NULL`),
    recentFeedback: await one(`SELECT ts, version, message, contact FROM feedback ORDER BY ts DESC LIMIT 50`),
    recentErrors: await one(`SELECT ts, version, message FROM logs WHERE level='error' ORDER BY ts DESC LIMIT 50`),
  });
});

init()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('telemetry up')))
  .catch((e) => { console.error('init failed', e); process.exit(1); });
