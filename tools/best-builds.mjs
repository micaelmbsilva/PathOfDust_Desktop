// Search the best reachable build per archetype under the modeled ruleset
// (5 Perfect items, 4 crafted mods each + 1 Sacred, no uniques/krangle),
// jointly optimizing gear affixes and the passive tree for one objective at a
// time. Uses the same advisor-core math the site scores players with.
//
// Run: node tools/best-builds.mjs [level] [tier]
//   -> prints a ranked report and writes tools/best-builds.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { emptyBuckets, classScore, bestTree, pointsForLevel } from '../server/public/advisor-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, '..', 'server', 'public', p), 'utf8'));
const model = read('game-model.json');
const tree = read('passive-tree.json');

const LEVEL = +(process.argv[2] || 119);
const TIER = +(process.argv[3] || 119);
const POINTS = pointsForLevel(LEVEL);

// A Perfect item's best case: primary = base × tier × 1.2 (roll) × 1.2
// (Perfect); every affix = perTier × tier × 1.15 (max jitter) × 1.2 (Perfect),
// which is the same 1.38× a Sacred implicit gets — Sacred's edge is being a
// 5th affix outside the craft cap, not a bigger number.
const R = model.rules;
const PRIMARY = (slot) => R.slotBasePower[slot] * TIER * R.powerRollRange[1] * R.perfectMult;
const AFFIX = (a) => a.perTier * TIER * R.affixJitter[1] * R.perfectMult;

// 20 crafted mod slots (4 per equip slot) + 1 Sacred. Only weapon and helm
// can roll the 5 elemental affixes; Sacred ignores slot eligibility entirely.
const SLOTS = ['weapon', 'helm', 'body', 'gloves', 'boots'];
// "max hp" is two distinct Rust affixes sharing one label (IncreasedLife %,
// FlatLife raw) — the model file folds them into one entry, so split them
// back out here or the flat variant can never be picked.
const CHOICES = model.affixes.flatMap((a) => a.flatBucket
  ? [{ ...a, label: a.match + ' %' }, { match: a.match, label: a.match + ' flat', bucket: a.flatBucket, perTier: a.flatPerTier, slots: a.slots }]
  : [{ ...a, label: a.match }]);
const eligible = (slot) => CHOICES.filter((a) => !a.slots || a.slots.includes(slot));

function baseGear() {
  const g = emptyBuckets();
  g.weaponPower = PRIMARY('weapon');
  g.bodyPower = PRIMARY('body');
  g.attackSpeed = PRIMARY('gloves');
  g.helmPower = PRIMARY('helm');
  const c = R.cooldownCurves.helm;
  g.helmCooldownMs = Math.max(c.floorMs, c.baseMs - TIER * c.perTierMs);
  return g;
}

// Greedy fill of the 21 affix slots for one objective, given a fixed tree.
function bestGear(cls, alloc, objective) {
  const g = baseGear();
  const left = Object.fromEntries(SLOTS.map((s) => [s, R.modCap]));
  const picks = Object.fromEntries(SLOTS.map((s) => [s, []]));
  const t = { nodes: tree.classes[cls], alloc };
  const value = () => objective(classScore(cls, g, LEVEL, model, t));
  let cur = value();
  for (let n = 0; n < SLOTS.length * R.modCap; n++) {
    let pick = null;
    for (const slot of SLOTS) {
      if (!left[slot]) continue;
      for (const a of eligible(slot)) {
        const v = AFFIX(a);
        g[a.bucket] += v;
        const gain = value() - cur;
        g[a.bucket] -= v;
        if (gain > 0 && (!pick || gain > pick.gain)) pick = { slot, a, v, gain };
      }
    }
    if (!pick) break;
    g[pick.a.bucket] += pick.v;
    picks[pick.slot].push(pick.a.label);
    left[pick.slot]--;
    cur += pick.gain;
  }
  // The one Sacred: any affix, any slot, same 1.38× value, may duplicate.
  let sac = null;
  for (const a of CHOICES) {
    const v = AFFIX(a);
    g[a.bucket] += v;
    const gain = value() - cur;
    g[a.bucket] -= v;
    if (!sac || gain > sac.gain) sac = { a, v, gain };
  }
  g[sac.a.bucket] += sac.v;
  return { g, picks, sacred: sac.a.label };
}

// Gear and tree each change what the other is worth (overflow conversions,
// Titan's Grip, the divine heal loop), so alternate until it settles.
function optimize(cls, objective) {
  let alloc = {}, gear = bestGear(cls, alloc, objective);
  for (let i = 0; i < 4; i++) {
    const t = bestTree(cls, tree.classes[cls], gear.g, LEVEL, model, POINTS, objective);
    const next = bestGear(cls, t.alloc, objective);
    const settled = objective(classScore(cls, next.g, LEVEL, model, { nodes: tree.classes[cls], alloc: t.alloc }))
      <= objective(classScore(cls, gear.g, LEVEL, model, { nodes: tree.classes[cls], alloc })) * 1.0001;
    alloc = t.alloc; gear = next;
    if (settled) break;
  }
  const t = { nodes: tree.classes[cls], alloc };
  return { cls, alloc, gear, score: classScore(cls, gear.g, LEVEL, model, t) };
}

const OBJECTIVES = {
  damage: (s) => s.dps,
  tank: (s) => s.ehp,
  healing: (s) => s.hps,
  overall: (s) => s.score,
};

const classes = Object.keys(model.archetypes).filter((c) => tree.classes[c] && tree.classes[c].length);
const out = { level: LEVEL, tier: TIER, points: POINTS, ruleset: model.note, results: {} };
const nameOf = (cls, key) => (tree.classes[cls].find((n) => n.key === key) || {}).name || key;
const pct = (x) => (x * 100).toFixed(1) + '%';

for (const [obj, fn] of Object.entries(OBJECTIVES)) {
  const ranked = classes.map((c) => optimize(c, fn)).sort((a, z) => fn(z.score) - fn(a.score));
  out.results[obj] = ranked.map((r) => ({
    cls: r.cls,
    dps: r.score.dps, hps: r.score.hps, ehp: r.score.ehp, hp: r.score.hp,
    inc: r.score.detail.inc, critChance: r.score.detail.cc, critMult: r.score.detail.cm,
    eff: r.score.detail.eff, taken: r.score.detail.taken, healPower: r.score.healPower,
    intervalMs: r.score.interval, splash: r.score.splash, linger: r.score.detail.lingerPct,
    tree: Object.fromEntries(Object.entries(r.alloc).map(([k, v]) => [nameOf(r.cls, k), v])),
    gear: r.gear.picks, sacred: r.gear.sacred,
  }));
  console.log(`\n=== best ${obj} — level ${LEVEL}, tier ${TIER} gear, ${POINTS} passive points ===`);
  for (const x of out.results[obj].slice(0, 5)) {
    console.log(`${x.cls.padEnd(10)} dps ${x.dps.toExponential(3)}  hps ${x.hps.toExponential(3)}  ehp ${x.ehp.toExponential(3)}`
      + `  inc ${pct(x.inc)}  cc ${x.critChance.toFixed(1)}  cm ${x.critMult.toFixed(1)}`
      + `  dr/blk/eva ${pct(x.eff.dr)}/${pct(x.eff.block)}/${pct(x.eff.evasion)}  heal ${pct(x.healPower)}  ${x.intervalMs.toFixed(0)}ms`);
  }
}

writeFileSync(join(here, 'best-builds.json'), JSON.stringify(out, null, 1) + '\n');
console.log('\nwrote tools/best-builds.json');
