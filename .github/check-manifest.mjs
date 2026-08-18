// Sanity-checks version.json, the interface manifest the hot-pull reads.
//
// The revision is compared NUMERICALLY by two independent pullers — main.cjs
// (launch) and server.mjs (periodic) — and autoreload.js refuses anything that
// isn't a number, so a string here would persist and then silently stop every
// page from reloading after an update. A missing file makes the whole pull throw
// and back off, so one bad entry freezes updates for every client.
//
// Run: node .github/check-manifest.mjs
import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const man = JSON.parse(await readFile(new URL('version.json', root), 'utf8'));
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };

if (!Number.isInteger(man.version) || man.version <= 0)
  fail(`version must be a positive integer, got ${JSON.stringify(man.version)}`);

if (!Array.isArray(man.files) || !man.files.length) fail('files must be a non-empty array');
else {
  // Same rule both pullers enforce before writing (safeFile): a manifest name
  // goes straight into a write path, so no traversal, absolute path or drive
  // letter may appear.
  const safe = (f) => typeof f === 'string' && f.length > 0 && f.length < 200
    && !/[\\/]{2}|(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:|\0/.test(f) && !/[<>:"|?*]/.test(f);
  const seen = new Set();
  for (const f of man.files) {
    if (!safe(f)) { fail(`unsafe manifest entry: ${JSON.stringify(f)}`); continue; }
    if (seen.has(f)) fail(`duplicate manifest entry: ${f}`);
    seen.add(f);
    try { await access(new URL(f, root)); } catch { fail(`manifest lists a missing file: ${f}`); }
  }
}

if (!process.exitCode) console.log(`✓ manifest rev ${man.version}, ${man.files.length} files, all present`);
