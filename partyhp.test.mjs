// advanceHp lives inline in index.html (no module boundary to import), so this
// lifts the function out by brace-matching and runs it headless. It exists
// because the party HP bars have no other way to be tested: they only move
// during a live fight, and the two data sources behind them are wildly
// different in shape — per-hit attack events (thousands per fight) against
// playerVitals anchors (a median of TWO samples per player per fight). Getting
// that precedence wrong is invisible in review and obvious on screen.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const head = '  function advanceHp(cursor) {';
const i = src.indexOf(head);
assert.notEqual(i, -1, 'advanceHp not found in index.html');
let depth = 0, k = src.indexOf('{', i);
for (;; k++) {
  if (src[k] === '{') depth++;
  else if (src[k] === '}' && --depth === 0) break;
}
const advanceHp = new Function(`let fight;
  ${src.slice(i, k + 1)}
  return (f, cursor) => { fight = f; advanceHp(cursor); };`)();

// A takes a hit every 100ms and dies at 400; B never appears in the event log
// (thinning drops it) and has only its two vitals anchors.
const scene = () => ({
  hpIdx: 0,
  evs: [
    { atMs: 100, kind: 'attack', target: 'A', targetHpAfter: 90 },
    { atMs: 200, kind: 'attack', target: 'A', targetHpAfter: 70 },
    { atMs: 300, kind: 'attack', target: 'A', targetHpAfter: 40 },
    { atMs: 400, kind: 'defeat', unit: 'A' },
  ],
  vitals: { A: { samples: [[0, 100], [250, 60]], diedAt: null, idx: 0 },
            B: { samples: [[0, 100], [400, 20]], diedAt: null, idx: 0 } },
  unitHp: { A: { max: 100, hp: 100, shield: 0 }, B: { max: 100, hp: 100, shield: 0 } },
});

const f = scene();
const hp = {};
for (const c of [100, 150, 200, 260, 300, 400, 500]) {
  advanceHp(f, c);
  hp[c] = [+f.unitHp.A.hp.toFixed(1), +f.unitHp.B.hp.toFixed(1)];
}

assert.equal(hp[100][0], 90, 'A steps on its own hits');
assert.equal(hp[150][0], 90, 'A holds between hits — the events ARE the motion');
assert.equal(hp[260][0], 60, 'A re-anchors on the 250ms vitals sample');
assert.equal(hp[300][0], 40, 'a stale anchor never undoes a newer hit');
assert.equal(hp[400][0], 0, 'defeat empties the bar');
assert.equal(hp[500][0], 0, 'and it stays empty');
assert.deepEqual([hp[100][1], hp[200][1], hp[300][1]], [80, 60, 40],
  'a unit with no events glides between anchors instead of freezing');
assert.equal(hp[400][1], 20, 'and lands exactly on the anchor');

console.log('party HP tests passed');
