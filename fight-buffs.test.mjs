// Shield/buffSnapshot readout on an expanded Fight History card lives inline
// in fights.html (no module boundary to import), so this lifts the pieces out
// by text/brace match and runs them headless, the same way partyhp.test.mjs
// and wire.test.mjs do for index.html.
//
// Three things matter here:
//   * the parser agrees with the contract this repo was actually delivered
//     (golden-bundle.v1.json + replay-bundle-validator.mjs, from the
//     replay-bundle-contract PR) — not a hand-rolled shape that happens to
//     look right.
//   * a fight with no bundle never asks for anything (no bundleSeq -> no
//     fetch, ever — see wantsBuffs).
//   * every denial shape (HTTP failure, {ok:false} from the bridge, a
//     malformed member) degrades to null, quietly, once — never throws,
//     never retries.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { validateEvent } from './replay-bundle-validator.mjs';

const src = readFileSync(new URL('./fights.html', import.meta.url), 'utf8');

const liftLine = (name) => {
  const m = src.match(new RegExp(`^ *const ${name} = [^\\n]*(\\n[^\\n]*?;)?`, 'm'));
  assert.ok(m, `${name} not found in fights.html`);
  return m[0];
};
const liftFn = (head) => {
  const i = src.indexOf(head);
  assert.notEqual(i, -1, `${head} not found in fights.html`);
  let depth = 0, k = src.indexOf('{', i);
  for (;; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) break;
  }
  return src.slice(i, k + 1);
};

const wantsBuffs = new Function(`${liftLine('wantsBuffs')}; return wantsBuffs;`)();
const parseBuffsMemberSrc = liftFn('function parseBuffsMember(events) {');
const fetchAndParseBuffsSrc = liftFn('async function fetchAndParseBuffs(seq) {');
const parseBuffsMember = new Function(`${parseBuffsMemberSrc}; return parseBuffsMember;`)();
// fetchAndParseBuffs closes over parseBuffsMember and the global `fetch` — a
// mock is injected as a parameter so it resolves inside the lifted body
// instead of hitting the network.
const makeFetchAndParseBuffs = (fetchImpl) => new Function('fetch', `
  ${parseBuffsMemberSrc}
  ${fetchAndParseBuffsSrc}
  return fetchAndParseBuffs;
`)(fetchImpl);

// ---- happy path: the real, delivered contract -----------------------------
// golden-bundle.v1.json is owned upstream (see bundle-contract.test.mjs) —
// exercising it here means a schema change that reaches this repo is caught
// by the SAME fixture this parser is meant to agree with, not a fixture this
// file invented for itself.
const golden = JSON.parse(
  readFileSync(new URL('./fixtures/replay-bundle/golden-bundle.v1.json', import.meta.url), 'utf8'),
);
const buffEvents = golden.members.buffs;

{
  const errors = [];
  buffEvents.forEach((e, i) => validateEvent(e, `members.buffs[${i}]`, errors));
  assert.deepEqual(errors, [], 'the golden buffs member must itself be schema-valid before parsing it');
}

const parsed = parseBuffsMember(buffEvents);
assert.ok(parsed, 'a real participant-tier buffs member must parse');
assert.equal(parsed.shields.get('kazesosa|lokati_gaming'), 15000, 'a cross-target shield is summed under healer|target');
assert.deepEqual(parsed.snaps.get('__enemy_0__'), [['curse_dmg_taken_bonus', 0.68]]);
assert.deepEqual(parsed.snaps.get('lokati_gaming'), [], 'an empty buffs list is still a real snapshot, not absence');

// A later, larger seq for the same unit must win — "latest snapshot" means
// the last one written, not the first one seen.
const overwritten = parseBuffsMember([
  { seq: 1, kind: 'buffSnapshot', atMs: 0, unit: 'a', buffs: [['marked', 1]] },
  { seq: 5, kind: 'buffSnapshot', atMs: 500, unit: 'a', buffs: [['wound_stacks', 3]] },
]);
assert.deepEqual(overwritten.snaps.get('a'), [['wound_stacks', 3]]);

// ---- absent bundleSeq: never asked for -------------------------------------
assert.equal(wantsBuffs({ bundleSeq: 3 }), true);
// wantsBuffs is `f && Number.isInteger(f.bundleSeq)`, so a falsy `f` short-
// circuits to `f` itself rather than coercing to `false` — checked for
// falsiness, matching every call site's `if (!wantsBuffs(f))`.
assert.ok(!wantsBuffs({}), 'a summary with no bundleSeq key at all must not trigger a fetch');
assert.ok(!wantsBuffs({ bundleSeq: null }));
assert.ok(!wantsBuffs(null));

// ---- denial fallback: every shape degrades to null, quietly ---------------
{
  const fetchAndParseBuffs = makeFetchAndParseBuffs(async () => ({ ok: false })); // HTTP-level failure (network, 5xx)
  assert.equal(await fetchAndParseBuffs(1), null);
}
{
  // The bridge's own denial shape — a 404 (missing bundle, non-participant,
  // unknown fight) all collapse to this one body, by design.
  const fetchAndParseBuffs = makeFetchAndParseBuffs(async () => ({ ok: true, json: async () => ({ ok: false }) }));
  assert.equal(await fetchAndParseBuffs(1), null);
}
{
  // Malformed member: an event stream that isn't an array at all.
  const fetchAndParseBuffs = makeFetchAndParseBuffs(async () => ({ ok: true, json: async () => ({ ok: true, events: 'not-an-array' }) }));
  assert.equal(await fetchAndParseBuffs(1), null);
}
{
  // A thrown fetch (offline, aborted) must not propagate.
  const fetchAndParseBuffs = makeFetchAndParseBuffs(async () => { throw new Error('offline'); });
  assert.equal(await fetchAndParseBuffs(1), null);
}
{
  // The happy path through the real fetch wrapper too, not just the parser.
  const fetchAndParseBuffs = makeFetchAndParseBuffs(async () => ({ ok: true, json: async () => ({ ok: true, events: buffEvents }) }));
  const r = await fetchAndParseBuffs(1);
  assert.ok(r, 'a genuine {ok:true, events} body must parse');
  assert.equal(r.shields.get('kazesosa|lokati_gaming'), 15000);
}

console.log('fight-buffs tests passed');
