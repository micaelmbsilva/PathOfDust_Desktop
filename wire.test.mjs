// The socket's wire layer lives inline in index.html (no module boundary to
// import), so this lifts the pieces out by text match and runs them headless,
// the same way partyhp.test.mjs does with advanceHp.
//
// It exists because all three of these are invisible in review and only fail in
// production, on the clients that opted in:
//
//   * frameBytes — a binary frame has no .length. Reading one yields undefined,
//     which turns the persisted byte counters into NaN and then, after the
//     throttled save round-trips them through JSON as null, silently resets
//     months of counting to zero. Those counters are the only measurement of
//     this socket anyone has.
//   * the deflate format — 'deflate' means zlib-wrapped (RFC 1950) to
//     DecompressionStream and raw deflate (RFC 1951) to a careless server. The
//     two differ by a two-byte header, so the wrong choice fails on the very
//     first frame, at which point the fallback is all that keeps the app alive.
//   * ordering — inflation is async, and this stream's order is load-bearing.
import { readFileSync } from 'node:fs';
import { deflateSync, deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

// Lift a single-line `const <name> = ...;` declaration.
const liftLine = (name) => {
  const m = src.match(new RegExp(`^ *const ${name} = [^\\n]*(\\n[^\\n]*?;)?`, 'm'));
  assert.ok(m, `${name} not found in index.html`);
  return m[0];
};
// Lift a `function <name>(...)` by brace matching.
const liftFn = (head) => {
  const i = src.indexOf(head);
  assert.notEqual(i, -1, `${head} not found in index.html`);
  let depth = 0, k = src.indexOf('{', i);
  for (;; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) break;
  }
  return src.slice(i, k + 1);
};

const frameBytes = new Function(`${liftLine('frameBytes')}; return frameBytes;`)();
const inflate = new Function(`${liftLine('inflate')}; return inflate;`)();
const WS0 = new Function(`${liftLine('WS0')}; return WS0;`)();

// ---- frameBytes ------------------------------------------------------------
// The regression this file was written for: every one of these used to be
// undefined except the string.
assert.equal(frameBytes('hello'), 5, 'string frames count UTF-16 units');
assert.equal(frameBytes(new ArrayBuffer(1234)), 1234, 'ArrayBuffer -> byteLength');
assert.equal(frameBytes(new Blob(['abcdef'])), 6, 'Blob -> size');
assert.equal(frameBytes(''), 0);
assert.equal(frameBytes(null), 0, 'a null frame must count as zero, never NaN');
assert.equal(frameBytes(undefined), 0);
for (const v of [frameBytes(new ArrayBuffer(8)), frameBytes(null), frameBytes('x')])
  assert.ok(Number.isFinite(v), 'frameBytes must never return a non-number');

// A zero-length binary frame must report 0, not fall through to the string
// branch — ?? only falls through on null/undefined, which is why it is used
// here rather than ||.
assert.equal(frameBytes(new ArrayBuffer(0)), 0);

// ---- the counter series ----------------------------------------------------
assert.ok('wire' in WS0 && 'bin' in WS0 && 'binFail' in WS0 && 'badFrames' in WS0,
  'WS0 must seed every counter, or a fresh install starts them at undefined');

const countWsSrc = liftFn('  function countWs(raw, d, wire) {');
const harness = (seed) => new Function(`
  let wsStats = ${JSON.stringify(seed)};
  const saveNetStats = () => {};
  console = { ...console, info: () => {} };
  ${countWsSrc}
  return { countWs, stats: () => wsStats };
`)();

{
  // One 200-char encounter that arrived as a 20-byte compressed frame.
  const h = harness({ ...WS0, byType: {} });
  const text = JSON.stringify({ type: 'encounter', events: new Array(3).fill(0), units: [] }).padEnd(200, ' ');
  h.countWs(text, JSON.parse(text.trim()), 20);
  const st = h.stats();
  assert.equal(st.size, 200, 'size stays the inflated JSON length — the historical series');
  assert.equal(st.wire, 20, 'wire is what actually crossed the socket');
  assert.equal(st.size / st.wire, 10, 'so the ratio is directly readable');
  assert.equal(st.byType.encounter.size, 200);
  assert.equal(st.byType.encounter.wire, 20);
  assert.equal(st.fights, 1);
  for (const [k, v] of Object.entries(st))
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} went non-finite`);
}

{
  // An uncompressed frame: wire is omitted and must default to the text length,
  // so a client that never opts in still produces a coherent ratio of 1.
  const h = harness({ ...WS0, byType: {} });
  h.countWs('abcde', { type: 'state' }, undefined);
  assert.equal(h.stats().wire, 5, 'a missing wire count falls back to the payload length');
  assert.equal(h.stats().size, 5);
}

{
  // Forward-migration: counters banked before this revision have no wire field
  // on the per-type entries. Adding to a missing field must not yield NaN.
  const old = { ...WS0, msgs: 9, size: 900, fights: 2, byType: { state: { n: 9, size: 900 } } };
  delete old.wire; delete old.bin; delete old.binFail; delete old.badFrames;
  const h = harness({ ...WS0, ...old, byType: old.byType });
  h.countWs('x'.repeat(100), { type: 'state' }, 10);
  const st = h.stats();
  assert.equal(st.size, 1000, 'the old total carries forward');
  assert.equal(st.byType.state.wire, 10, 'a pre-existing type entry gains wire without NaN');
  assert.ok(Number.isFinite(st.wire), 'wire survives a record that predates it');
}

// ---- the deflate format contract -------------------------------------------
// This is the half the server must match: DecompressionStream('deflate') reads
// zlib-wrapped deflate, which is what Rust's flate2 ZlibEncoder emits. If the
// server reaches for the raw-deflate encoder instead, every frame fails.
{
  const text = JSON.stringify({ type: 'encounter', events: [{ atMs: 1, kind: 'attack' }] });
  assert.equal(await inflate(deflateSync(Buffer.from(text))), text,
    'zlib-wrapped deflate must round-trip');

  await assert.rejects(
    () => inflate(deflateRawSync(Buffer.from(text))),
    'raw deflate must FAIL rather than decode to garbage — the fallback depends on it throwing',
  );
}

{
  // A truncated frame — the realistic corruption case — must also reject, so
  // dropCompression runs instead of JSON.parse being handed a half a payload.
  const full = deflateSync(Buffer.from(JSON.stringify({ type: 'state' }).repeat(20)));
  await assert.rejects(() => inflate(full.subarray(0, full.length - 4)),
    'a truncated frame must reject');
}

// ---- ordering --------------------------------------------------------------
// The chained-promise shape from watchEvents, verified against a decompressor
// that finishes out of order. Same-atMs events are ordered by arrival, so a
// handler that ran them in completion order would silently corrupt a replay.
{
  let chain = Promise.resolve();
  const queue = (fn) => { chain = chain.then(fn).catch(() => {}); };
  const seen = [];
  const slowFirst = (n) => new Promise((r) => setTimeout(() => r(n), n === 1 ? 30 : 0));
  for (const n of [1, 2, 3]) queue(() => slowFirst(n).then((v) => { seen.push(v); }));
  await chain;
  assert.deepEqual(seen, [1, 2, 3], 'frames must be handled in arrival order, not completion order');
}

{
  // One frame that throws must not stall or unchain the ones behind it.
  let chain = Promise.resolve();
  const queue = (fn) => { chain = chain.then(fn).catch(() => {}); };
  const seen = [];
  queue(() => { seen.push('a'); });
  queue(() => Promise.reject(new Error('will not inflate')));
  queue(() => { seen.push('c'); });
  await chain;
  assert.deepEqual(seen, ['a', 'c'], 'a failed frame must not take the queue down with it');
}

console.log('wire tests passed');
