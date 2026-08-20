// optSlot and pickExisting live inline in bag.html (no module boundary to
// import), so this lifts them out by brace-matching and runs them headless —
// same trick partyhp.test.mjs uses. Both fixed a bug that is invisible in
// review: the craft picker's slot filter silently matched nothing for bag
// items, and the Item A restore silently fell back to equipped gear whenever
// its id had been consumed (which is what every Recombine does).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('./bag.html', import.meta.url), 'utf8');

// The whole function declaration starting at `head`, brace-matched.
const lift = (head) => {
  const i = src.indexOf(head);
  assert.notEqual(i, -1, `${head.trim()} not found in bag.html`);
  let depth = 0, k = src.indexOf('{', i);
  for (;; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) break;
  }
  return src.slice(i, k + 1);
};
// One whole source line, so the test breaks rather than drifts if it changes.
const line = (needle) => {
  const l = src.split('\n').find(x => x.trim().startsWith(needle));
  assert.ok(l, `no line starting with ${needle}`);
  return l;
};

const optSlot = new Function(
  `${line('const SLOTS =')}\n${line('const slotFromLabel =')}\n` +
  `${lift('  function optSlot(md, text) {')}\nreturn optSlot;`)();
const pickExisting = new Function(
  `${lift('    function pickExisting(sel, vals) {')}\nreturn pickExisting;`)();

// --- optSlot: the game only prints the slot in the "Equipped" group ---
assert.equal(optSlot({ group: 'Body', label: 'Plate (T3, 2 mods Q40%)' }, 'Plate (T3, 2 mods Q40%)'),
  'body', 'a per-slot optgroup names the slot even though the label does not');
assert.equal(optSlot({ group: 'Equipped', label: 'Plate (Body, T3, 2 mods Q40%)' }, ''),
  'body', 'the Equipped group folds the slot into the label instead');
assert.equal(optSlot({ group: 'Weapon', label: 'Blade (T1, 1 mod Sacred) 🔒' }, ''), 'weapon',
  'markers after the parens do not disturb it');
assert.equal(optSlot(undefined, 'Blade (Weapon, T1, 1 mod)'), 'weapon',
  'no option metadata at all still falls back to the label parse');
assert.equal(optSlot({ group: 'Sacred Items', label: 'Blade (T1, 1 mod)' }, ''), 't1',
  'an unknown group falls back too — matching no pip, same as before');

// --- pickExisting: first id that still exists wins ---
const sel = () => ({ value: '', options: [{ value: '' }, { value: 'eq' }, { value: 'new' }, { value: 'kept' }] });
let s = sel();
assert.equal(pickExisting(s, ['kept', 'new', 'eq']), 'kept', 'a live in-page pick wins');
assert.equal(s.value, 'kept');
s = sel();
assert.equal(pickExisting(s, ['gone', 'new', 'eq']), 'new', 'a consumed in-page id falls through to the stored one');
assert.equal(s.value, 'new');
s = sel();
assert.equal(pickExisting(s, ['gone', 'alsogone', 'new']), 'new',
  'both dead falls through to the site preselect — the recombine result, not equipped gear');
s = sel();
assert.equal(pickExisting(s, [undefined, null, '']), null, 'nothing to restore leaves the select alone');
assert.equal(s.value, '');

console.log('craft picker tests passed');

// --- craftable: the site lists Krangled items marked 🔒, but no craft works on one ---
const craftable = new Function(`${line('const craftable =')}
return craftable;`)();
assert.equal(craftable({ id: 'i1', label: 'Blade (T1, 1 mod Sacred) 🔒' }, new Set()), false,
  'a locked item is not offered');
assert.equal(craftable({ id: 'i1', label: 'Blade (T1, 1 mod Sacred) 🔒' }, new Set(['i1'])), true,
  'the item you just Krangled stays while it is the one picked — name it, or disenchant it');
assert.equal(craftable({ label: 'Blade (T1, 1 mod Sacred) ✦' }), true, '✦ is unique, a different marker — still craftable');
assert.equal(craftable({ label: 'Blade (T1, 1 mod Q40%)' }), true, 'an unmarked item is craftable');
assert.equal(craftable({ id: 'i1', label: 'Blade (T1, 1 mod Q40%)' }), true,
  "Keep only guards disenchant — a Keep'd item still crafts, so it stays in the picker");

// --- craftCost: the price a click spends before the game has answered ---
const craftCost = new Function(`${lift('  function craftCost(a, c) {')}
return craftCost;`)();
const ctx = (o = {}) => ({ tierA: 0, qualA: 0, perfA: false, pool: 0, veiled: false, ...o });
assert.deepEqual(craftCost({ polish: true }, ctx({ qualA: 45 })), { sand: 5 }, 'polish rounds the quality tenth up');
assert.deepEqual(craftCost({ polish: true }, ctx({ qualA: 45, perfA: true })), { sand: 12 }, 'a Perfect item polishes at a flat 12');
assert.deepEqual(craftCost({ reforge: true }, ctx({ tierA: 3 })), { dust: 90 }, 'reforge is 30 per tier');
assert.deepEqual(craftCost({ divineDustApply: true }, ctx({ tierA: 4 })), { dd: 8 }, 'divine dust is 2 per tier');
assert.deepEqual(craftCost({ base: null, label: 'Krangle' }, ctx({ tierA: 9 })), {},
  'token buttons cost no currency — nothing to spend');
assert.deepEqual(craftCost({ base: 100 }, ctx({ tierA: 2 })), { dust: 106 }, 'base plus 3 per tier');
assert.deepEqual(craftCost({ base: 100, veilExtra: 500 }, ctx({ tierA: 2, veiled: true })), { dust: 606 },
  'veiling adds its flat extra');
assert.deepEqual(craftCost({ base: 200, veilExtra: 500, recombine: true }, ctx({ tierA: 2, pool: 3, veiled: true })),
  { dust: 2200 }, 'recombine ignores tier and pays 500 per combined modifier on top');
