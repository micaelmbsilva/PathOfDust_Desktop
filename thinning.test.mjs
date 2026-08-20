// thinningOf lives inline in index.html (no module boundary to import), so this
// lifts the function out by brace-matching and runs it headless — same trick
// partyhp.test.mjs uses on advanceHp.
//
// It exists because thinningOf mirrors a server rule it cannot see. The game's
// thin_events_for_overlay budgets ATTACK events only (heal/defeat/skillCast are
// exempt as of 2026-08-20), so a tally that counts every kind flags honest
// seconds as trimmed and the app warns about data loss that never happened.
// That failure is invisible in review — the badge just shows up — and only
// reproduces on a fight busy enough to be hard to stage by hand.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

// Lifted from source rather than redeclared, so the test can't drift from the
// real caps the way a copied constant would.
const capLine = src.match(/^ *const OVERLAY_CAP = .*$/m);
const actorLine = src.match(/^ *const actorOf = .*$/m);
assert.ok(capLine, 'OVERLAY_CAP not found in index.html');
assert.ok(actorLine, 'actorOf not found in index.html');

const head = '  function thinningOf(d) {';
const i = src.indexOf(head);
assert.notEqual(i, -1, 'thinningOf not found in index.html');
let depth = 0, k = src.indexOf('{', i);
for (;; k++) {
  if (src[k] === '{') depth++;
  else if (src[k] === '}' && --depth === 0) break;
}
const { thinningOf, CAP } = new Function(`${capLine[0]}
  ${actorLine[0]}
  ${src.slice(i, k + 1)}
  return { thinningOf, CAP: OVERLAY_CAP };`)();

const units = [
  { id: 'me' }, { id: 'ally' },
  { id: 'boss1', isBoss: true },
  { id: '__enemy_3' }, // adds carry no isBoss flag — the id prefix is the tell
];
// n events of one kind inside second 0, from one actor.
const burst = (n, kind, actor) => Array.from({ length: n }, () => (
  kind === 'attack' ? { kind, atMs: 0, attacker: actor, target: 'me' }
    : kind === 'heal' ? { kind, atMs: 0, healer: actor, target: 'me' }
      : { kind, atMs: 0, unit: actor }));

// A second at the attack cap is the tell: the server keeps exactly `cap`
// attacks out of an over-budget second, never more.
assert.deepEqual(
  thinningOf({ units, events: burst(CAP.player + 100, 'attack', 'ally') }),
  { player: 1, boss: 0, secs: 1 },
  'a player second over the attack cap should be flagged');

// The regression this file exists for: exempt kinds must not count toward the
// budget. The old all-event tally flagged this second; nothing was trimmed.
assert.equal(
  thinningOf({ units, events: [
    ...burst(CAP.player - 100, 'attack', 'ally'),
    ...burst(400, 'heal', 'me'),
    ...burst(50, 'defeat', 'ally'),
  ] }),
  null,
  'heals and defeats must not push an under-budget second over the cap');

// Exempt kinds alone can never flag, at any volume.
assert.equal(thinningOf({ units, events: burst(5000, 'heal', 'me') }), null,
  'heals are never budgeted, so they can never be trimmed');

// Bosses get the higher cap — a boss burst between the two caps is untrimmed.
assert.equal(thinningOf({ units, events: burst(CAP.player + 100, 'attack', 'boss1') }), null,
  'a boss second under the boss cap should not be flagged');
assert.deepEqual(
  thinningOf({ units, events: burst(CAP.boss, 'attack', 'boss1') }),
  { player: 0, boss: 1, secs: 1 },
  'a boss second at the boss cap should be flagged');

// Adds are classified by id prefix, not by an isBoss flag they don't carry.
assert.deepEqual(
  thinningOf({ units, events: burst(CAP.boss, 'attack', '__enemy_3') }),
  { player: 0, boss: 1, secs: 1 },
  '__enemy ids should count against the boss cap');

// Seconds are counted independently, and `secs` reports every second that held
// attacks — the denominator the badge shows.
{
  const events = [
    ...burst(CAP.player + 1, 'attack', 'ally'),
    ...burst(10, 'attack', 'ally').map(e => ({ ...e, atMs: 1500 })),
  ];
  assert.deepEqual(thinningOf({ units, events }), { player: 1, boss: 0, secs: 2 });
}

console.log('thinning: ok');
