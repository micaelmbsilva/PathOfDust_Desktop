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
// `nodes` is passive-tree.json with the prose and effect math stripped: enough
// to turn a scraped tree (which carries node NAMES only — the read-only
// /characters/:login/passives page has no form, so no node_key) back into
// allocatable keys in a legal order. Rides along here because server/public is
// not shipped with the app and this file already is.
const out = {
  level: LEVEL, tier: TIER, points: POINTS, ruleset: model.note, results: {},
  nodes: Object.fromEntries(classes.map((c) => [c, tree.classes[c].map(
    ({ key, name, tier: t, parent, unlockAt, max }) => ({ key, name, tier: t, parent, unlockAt, max }))])),
};
const nodeOf = (cls, key) => tree.classes[cls].find((n) => n.key === key) || {};
const nameOf = (cls, key) => nodeOf(cls, key).name || key;
// Node keys in an order the game will accept: tier order (Skills -> Specs ->
// Modifiers), and within that, a parent always before its children. Same rule
// docs/memories_spec.md gives for replaying a saved build — the dossier page
// replays these one allocate call at a time, so a child sent first would be
// refused with ParentNotInvested.
const TIERS = ['skill', 'spec', 'modifier'];
function orderedAlloc(cls, alloc) {
  const rows = Object.entries(alloc).map(([key, rank]) => ({ key, rank, ...nodeOf(cls, key) }));
  rows.sort((a, z) => TIERS.indexOf(a.tier) - TIERS.indexOf(z.tier));
  const out = [], done = new Set();
  while (rows.length) {
    const i = rows.findIndex((r) => !r.parent || done.has(r.parent));
    if (i < 0) throw new Error(`${cls}: allocation has an unreachable parent chain`);
    const [r] = rows.splice(i, 1);
    done.add(r.key);
    out.push({ key: r.key, name: r.name || r.key, rank: r.rank, tier: r.tier });
  }
  return out;
}
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
    // Keyed + ordered twin of `tree`, for anything that replays the build into
    // the live game rather than printing it.
    alloc: orderedAlloc(r.cls, r.alloc),
    gear: r.gear.picks, sacred: r.gear.sacred,
  }));
  console.log(`\n=== best ${obj} — level ${LEVEL}, tier ${TIER} gear, ${POINTS} passive points ===`);
  for (const x of out.results[obj].slice(0, 5)) {
    console.log(`${x.cls.padEnd(10)} dps ${x.dps.toExponential(3)}  hps ${x.hps.toExponential(3)}  ehp ${x.ehp.toExponential(3)}`
      + `  inc ${pct(x.inc)}  cc ${x.critChance.toFixed(1)}  cm ${x.critMult.toFixed(1)}`
      + `  dr/blk/eva ${pct(x.eff.dr)}/${pct(x.eff.block)}/${pct(x.eff.evasion)}  heal ${pct(x.healPower)}  ${x.intervalMs.toFixed(0)}ms`);
  }
}

// Replay every emitted allocation the way the game will (passive_tree.rs's
// validate_allocation_step): ranks within max, a parent invested to unlock_at
// BEFORE its child, and the whole thing inside the point budget. The dossier
// page fires one allocate call per node in this order, so a bad order here is a
// half-applied tree on someone's character.
for (const list of Object.values(out.results)) {
  for (const r of list) {
    const side = {};
    for (const n of r.alloc) {
      const node = nodeOf(r.cls, n.key);
      if (!(n.rank > 0 && n.rank <= node.max)) throw new Error(`${r.cls}/${n.key}: rank ${n.rank} over max ${node.max}`);
      if (node.parent && (side[node.parent] || 0) < (node.unlockAt ?? 1)) throw new Error(`${r.cls}/${n.key}: parent ${node.parent} not invested yet`);
      side[n.key] = n.rank;
    }
    const spent = Object.values(side).reduce((a, v) => a + v, 0);
    if (spent > POINTS) throw new Error(`${r.cls}: ${spent} points over the ${POINTS} budget`);
  }
}

writeFileSync(join(here, 'best-builds.json'), JSON.stringify(out, null, 1) + '\n');
console.log('\nwrote tools/best-builds.json');
