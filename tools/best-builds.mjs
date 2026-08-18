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
import { searchBuild, pointsForLevel } from '../server/public/advisor-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, '..', 'server', 'public', p), 'utf8'));
const model = read('game-model.json');
const tree = read('passive-tree.json');

const LEVEL = +(process.argv[2] || 119);
const TIER = +(process.argv[3] || 119);
const POINTS = pointsForLevel(LEVEL);

// The whole gear+tree search now lives in advisor-core's searchBuild (shared
// with the site's #/explorer route) — this tool is just a batch driver over it.
const optimize = (cls, objective) => searchBuild(cls, tree.classes[cls], LEVEL, TIER, model, { objective });

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
