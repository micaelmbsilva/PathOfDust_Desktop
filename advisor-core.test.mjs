// node advisor-core.test.mjs — asserts the scoring core against the game
// math it mirrors (PathofDust source cites in server/public/game-model.json).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMod, parseItem, sumBuckets, classScore, bestLoadout, rollTargets, trimOrder, emptyBuckets,
  treeLayer, bestTree, pointsForLevel, searchBuild, nodeScored, MODELED_SPECIAL_KEYS, statPriority,
  nodeMagnitude } from './server/public/advisor-core.mjs';

const model = JSON.parse(readFileSync(new URL('./server/public/game-model.json', import.meta.url)));

// parseMod: label precedence + flat/% max hp split
assert.deepEqual(parseMod('+18% crit chance', model), { bucket: 'critChance', value: 0.18, perTier: 0.01 });
assert.equal(parseMod('+40% crit dmg dealt', model).bucket, 'critMult'); // not swallowed by "dmg dealt"
assert.equal(parseMod('+90% dmg dealt', model).bucket, 'inc');
assert.equal(parseMod('+12% max hp', model).bucket, 'incLife');
assert.equal(parseMod('+25 max hp', model).bucket, 'flatLife');
assert.equal(parseMod('+25 max hp', model).value, 25);
assert.equal(parseMod('+1.13% cold damage (evasion debuff chance)', model).bucket, 'elemCold');
assert.equal(parseMod('mystery garbage', model), null);

// parseItem: sacred implicit counted, unique implicit skipped, krangled → best 4
const item = {
  slot: 'Weapon', tier: 't100', primary: '+120 power', krangled: true,
  mods: [
    { t: '+200% evasion' }, { t: '+10% block chance' }, { t: '+300% dmg dealt' },
    { t: '+100% crit chance' }, { t: '+2% intervene' }, { t: '+500% crit dmg dealt' },
  ],
  implicits: [{ t: 'Sacred: +224% splash' }, { t: 'Celestial Conversion: 10% extra hit' }],
};
const p = parseItem(item, model);
// tier-equivalents: evasion 125, block 5, inc 100, critChance 100, intervene 2, critMult 100 → drop block+intervene
assert.equal(p.block, 0);
assert.equal(p.intervene, 0);
assert.equal(p.evasion, 2.0);
assert.equal(p.splash, 2.24); // sacred kept, outside the 4 cap
assert.equal(p.weaponPower, 120);
const noCelestial = parseItem({ slot: 'Helm', tier: 't10', mods: [], implicits: [{ t: 'Celestial Conversion: x' }] }, model);
assert.deepEqual(noCelestial.splash, 0);
// live scrape prefixes the implicit with a "✦ " glyph — must still count
const glyph = parseItem({ slot: 'Helm', tier: 'Tier 99', mods: [], implicits: [{ t: '✦ Sacred: +307.39% lightning damage (dmg taken debuff chance)' }] }, model);
assert.ok(Math.abs(glyph.elemLightning - 3.0739) < 1e-9);
assert.equal(glyph.tier, 99);

// classScore: overflow — raw 0.90 DR at cap 0.75 → eff 0.75, spill 0.15 into inc
const g1 = { ...emptyBuckets(), dr: 0.90 };
const s1 = classScore('Commoner' in model.archetypes ? 'Commoner' : 'Berserker', g1, 0, model);
// Berserker at level 0: B.inc = 0.25; overflow must appear in detail.inc
assert.ok(Math.abs(s1.overflow - 0.15) < 1e-9, `overflow ${s1.overflow}`);
assert.equal(s1.detail.eff.dr, 0.75);

// crit EV: cc 1.5, cm 12 — overcrit saturating curve (combat.rs crit_stack_bonus):
// two-point mixture of stacks 1 and 2. bonus(1) = 1×11×0.5 = 5.5,
// bonus(2) = (1 + 1.5×1/2)×11×0.5 = 9.625 → critF = 1 + 0.5×5.5 + 0.5×9.625 = 8.5625
{
  const g = { ...emptyBuckets(), critChance: 1.45, critMult: 10 }; // + base 0.05/2.0
  const s = classScore('Warrior', g, 0, model);
  const cc = s.detail.cc, cm = s.detail.cm;
  assert.ok(Math.abs(cc - 1.5) < 1e-9 && Math.abs(cm - 12) < 1e-9);
  const expected = 8.5625 / (1 + 0.05 * 1 * 0.5); // vs the 5%/2.0 baseline's own factor (sub-100% crit: unchanged by the curve)
  assert.ok(Math.abs((s.dps / classScore('Warrior', emptyBuckets(), 0, model).dps) / expected - 1) < 0.001);
}

// Slayer leech clamped at 20% maxHP/s
{
  const g = { ...emptyBuckets(), leech: 5, inc: 100 }; // absurd leech
  const s = classScore('Slayer', g, 50, model);
  const hp = (20 + 5 * 50) * 1;
  assert.ok(s.ehp <= hp / 0.25 + 0.2 * hp * model.proxies.leechSeconds + 1e-6);
}

// heal-power loop: Cleric at level 100 (arch heal power 5.5) hits the 50ms floor
{
  const s = classScore('Cleric', emptyBuckets(), 100, model);
  assert.ok(s.interval < 1700 / 5.5 + 1, `interval ${s.interval}`);
  const withDivine = classScore('Cleric', { ...emptyBuckets(), elemDivine: 4.5 }, 100, model);
  assert.ok(withDivine.interval <= s.interval); // divine stacks only speed it up
}

// trimOrder: budget 6 out of a 23-point order → prefix summing to 6
const order = [{ n: 'A', r: 3 }, { n: 'B', r: 4 }, { n: 'C', r: 3 }];
assert.deepEqual(trimOrder(order, 6), [{ n: 'A', r: 3 }, { n: 'B', r: 3 }]);

// Monk ≥ same gear with no archetype advantage (archetype bonus is pure upside)
{
  const g = { ...emptyBuckets(), evasion: 0.5 };
  assert.ok(classScore('Monk', g, 20, model).score >= classScore('Slayer', g, 20, model).score * 0.5);
}

// bestLoadout: strictly better bag item swapped in; unique bag item never used
{
  const equipped = [{ slot: 'Weapon', tier: 't10', primary: '+10 power', mods: [{ t: '+30% dmg dealt' }] }];
  const bag = [
    { slot: 'Weapon', tier: 't100', primary: '+100 power', mods: [{ t: '+300% dmg dealt' }] },
    { slot: 'Helm', tier: 't50', unique: true, mods: [{ t: '+999% dmg dealt' }] },
  ];
  const r = bestLoadout(equipped, bag, 'Berserker', 30, model);
  assert.equal(r.swaps.length, 1);
  assert.equal(r.swaps[0].slot, 'weapon');
  assert.ok(!r.items.some(i => i.unique));
}

// rollTargets: 4 picks per slot, sacred present, and every slot may now be
// planned with an elemental (affix.rs 2026-08-20 widen — eligible_slots: None).
{
  const r = rollTargets('Berserker', 50, 100, model, null, null);
  for (const slot of ['body', 'gloves', 'boots']) {
    assert.equal(r.plan[slot].length, 4);
  }
  assert.equal(r.plan.weapon.length, 4);
  // affix.rs is eligible_slots: None for every affix as of 2026-08-20, so no
  // model entry may carry a `slots` restriction. (The key stays supported —
  // a future affix can restrict itself again — it just isn't used today.)
  assert.ok(model.affixes.every(a => !a.slots), 'no affix is slot-restricted any more');
  assert.ok(r.sacred && r.sacred.avg > 0);
  // empirical override: perTier 0.03 vs empirical 0.06 (>20% off) → avg uses 0.06
  const r2 = rollTargets('Berserker', 50, 100, model, null, { 'dmg dealt': 0.06 });
  const inc2 = [].concat(...Object.values(r2.plan)).find(pk => pk.match === 'dmg dealt');
  if (inc2) assert.ok(Math.abs(inc2.avg - 6) < 1e-9);
}

// rollTargets: per-slot tier map — each slot's avg values use its own tier
{
  const r = rollTargets('Berserker', 50, { weapon: 100, helm: 50, body: 80, gloves: 80, boots: 80 }, model, null, null);
  const w = r.plan.weapon.find(pk => pk.match === 'dmg dealt');
  const h = r.plan.helm.find(pk => pk.match === 'dmg dealt');
  if (w && h) assert.ok(Math.abs(w.avg / h.avg - 2) < 1e-9, `weapon ${w.avg} vs helm ${h.avg}`);
  assert.ok(r.sacred.avg > 0);
}


// ---- passive tree layer (passive-tree.json, generated from passive_tree.rs) --
const tree = JSON.parse(readFileSync(new URL('./server/public/passive-tree.json', import.meta.url)));
const warrior = tree.classes.Warrior;

assert.equal(pointsForLevel(0), 1);
assert.equal(pointsForLevel(119), 30);

// FlatStat pooling + Colossus's cross-node special case: Juggernaut 3/3 is
// 24% max hp and Colossus scales it by its own magnitude on top. That magnitude
// is NOT a constant — the streamer can retune any node live and the export
// carries the tuned triplet — so derive the expectation instead of pinning a
// number that changes out from under the suite (it did: Colossus went from
// 0.5/0.75/1 to 1/2/3, turning "doubles" into "quadruples").
{
  const colossus = warrior.find((n) => n.key === 'colossus');
  const expected = 0.24 * (1 + nodeMagnitude(colossus, 3));
  const t = treeLayer(warrior, { juggernaut: 3, colossus: 3 }, {}, model);
  assert.ok(Math.abs(t.get('incLife') - expected) < 1e-9, `incLife ${t.get('incLife')}, expected ${expected}`);
  // A spec's 4th point unlocks children only — it must not grow the stat.
  const t4 = treeLayer(warrior, { juggernaut: 3, colossus: 4 }, {}, model);
  assert.ok(Math.abs(t4.get('incLife') - expected) < 1e-9);
}

// A live override (`effect.ranks`) is what the running game uses, so it must
// win over the source's own r1/per line — including the non-linear and
// non-monotonic shapes real overrides actually take, which no line can fit.
{
  const src = { magnitudeCap: 3, effect: { kind: 'flatStat', stat: 'CritMultiplier', r1: 0.03, per: 0.03 } };
  assert.ok(Math.abs(nodeMagnitude(src, 3) - 0.09) < 1e-9, 'no override: the r1/per line still applies');
  const tuned = { ...src, effect: { ...src.effect, ranks: [0.15, 0.3, 0.45] } };
  assert.deepEqual([1, 2, 3].map((r) => nodeMagnitude(tuned, r)), [0.15, 0.3, 0.45]);
  assert.equal(nodeMagnitude(tuned, 4), 0.45, "a spec's 4th point still does not grow the stat");
  assert.equal(nodeMagnitude(tuned, 0), 0, 'an unallocated node contributes nothing');
  const jagged = { magnitudeCap: 3, effect: { kind: 'special', r1: 4, per: -1, ranks: [1, 0.75, 0.5] } };
  assert.deepEqual([1, 2, 3].map((r) => nodeMagnitude(jagged, r)), [1, 0.75, 0.5], 'a descending override is used verbatim');
}

// OverflowConversion draws on COMBINED gear+tree overflow and is hard-capped
// at 0.10 per invested rank (OVERFLOW_CONVERSION_CAP_PER_RANK).
{
  const t = treeLayer(warrior, { bulwark: 3, unbreakable: 3 }, { block: 5.0 }, model);
  assert.ok(Math.abs(t.get('inc') - 0.30) < 1e-9, `unbreakable capped at 0.30, got ${t.get('inc')}`);
  const none = treeLayer(warrior, { unbreakable: 3 }, { block: 0.5 }, model);
  assert.equal(none.get('inc'), 0); // nothing past the 75% cap to convert
}

// Sources combine multiplicatively, never additively: gear 90% (capped 75%)
// and tree 90% (capped 75%) land at 93.75%, not 100%.
{
  const g = { ...emptyBuckets(), dr: 0.90 };
  const s = classScore('Commoner', g, 0, model, { nodes: warrior, alloc: { fortress: 3 } });
  // gear caps at 75%; Fortress 3/3 adds a 6% tree source on top: 1-(0.25)(0.94)
  assert.ok(Math.abs(s.detail.eff.dr - 0.765) < 1e-9, `dr ${s.detail.eff.dr}`);
  const both = classScore('Commoner', g, 0, model,
    { nodes: [{ key: 'x', name: 'x', parent: null, tier: 'skill', max: 3, magnitudeCap: 3, unlockAt: null,
      effect: { kind: 'flatStat', r1: 0.90, per: 0, stat: 'DamageReduction' } }], alloc: { x: 1 } });
  assert.ok(Math.abs(both.detail.eff.dr - 0.9375) < 1e-9, `dr ${both.detail.eff.dr}`);
}

// bestTree: never overspends, and only reaches a Modifier by paying its
// Specialization to 4/4 first (manager.rs's unlock gate).
{
  const g = { ...emptyBuckets(), block: 4.0 };
  const r = bestTree('Warrior', warrior, g, 119, model, 30);
  assert.ok(r.spent <= 30, `spent ${r.spent}`);
  assert.ok(Object.values(r.alloc).reduce((a, b) => a + b, 0) === r.spent);
  for (const [key, rank] of Object.entries(r.alloc)) {
    const n = warrior.find((x) => x.key === key);
    assert.ok(rank <= n.max, `${key} over max rank`);
    if (n.parent) assert.ok((r.alloc[n.parent] || 0) >= (n.unlockAt || 1), `${key} allocated without its parent gate`);
  }
  assert.ok(bestTree('Warrior', warrior, g, 119, model, 0).spent === 0);
}

// bestTree spendAll: the advisor's respec plan must spend EVERY point even after
// closed-form gain flattens (caps hit, heal power saturated); the default
// (theoretical optimizer) stops at the positive-gain ceiling. Both respect max
// ranks and parent gates.
{
  const paladin = tree.classes.Paladin;
  const g = { ...emptyBuckets(), weaponPower: 2000, elemDivine: 4, attackSpeed: 0.5 };
  const pts = pointsForLevel(184); // 47
  const ceiling = bestTree('Paladin', paladin, g, 184, model, pts);
  const full = bestTree('Paladin', paladin, g, 184, model, pts, (s) => s.score, true);
  assert.ok(ceiling.spent < pts, `ceiling should underspend, got ${ceiling.spent}`);
  assert.equal(full.spent, pts, `spendAll should spend all ${pts}, got ${full.spent}`);
  for (const [key, rank] of Object.entries(full.alloc)) {
    const n = paladin.find((x) => x.key === key);
    assert.ok(rank <= n.max, `${key} over max rank`);
    if (n.parent) assert.ok((full.alloc[n.parent] || 0) >= (n.unlockAt || 1), `${key} without parent gate`);
  }
}

// searchBuild: require forces an affix in, ban keeps it out, a clean run drops
// nothing. (The whole gear+tree search tools/best-builds.mjs and #/explorer run.)
{
  const nodes = tree.classes.Warrior;
  const base = searchBuild('Warrior', nodes, 119, 119, model);
  assert.ok(base.score.dps > 0 && (base.dropped || []).length === 0);
  const picksOf = (r) => [].concat(...Object.values(r.gear.picks), r.gear.sacred || []);
  const req = searchBuild('Warrior', nodes, 119, 119, model, { require: ['dmg dealt'] });
  assert.ok(picksOf(req).includes('dmg dealt'), 'required affix not placed');
  assert.equal(req.dropped.length, 0);
  const banned = searchBuild('Warrior', nodes, 119, 119, model, { ban: ['dmg dealt'] });
  assert.ok(!picksOf(banned).includes('dmg dealt'), 'banned affix appeared');
}

// nodeScored: flatStat true, unmodeled special false, modeled special true, none false
{
  const flat = { key: 'x', effect: { kind: 'flatStat', stat: 'DamageReduction' } };
  const overflow = { key: 'y', effect: { kind: 'overflowConversion' } };
  const spike = tree.classes.Warrior.find((n) => n.key === 'spikebarrier'); // reflect, unmodeled
  const secondSkin = tree.classes.Warrior.find((n) => n.key === 'secondskin'); // modeled special
  assert.equal(nodeScored(flat), true);
  assert.equal(nodeScored(overflow), true);
  assert.equal(nodeScored({ key: 'z', effect: { kind: 'none' } }), false);
  assert.ok(spike && nodeScored(spike) === false, 'spikebarrier reflect must read as unscored');
  assert.ok(secondSkin && nodeScored(secondSkin) === true, 'secondskin is a modeled special');
  assert.ok(MODELED_SPECIAL_KEYS.has('grimresolve'));
}

// statPriority: ranked desc, weight normalized to 1.0, elementals on every slot
{
  const g = { ...emptyBuckets(), weaponPower: 1500, attackSpeed: 0.4 };
  const sp = statPriority('Ranger', 119, 119, model, g, { nodes: tree.classes.Ranger, alloc: {} });
  assert.ok(sp.global.length > 0);
  assert.ok(sp.global.every((e, i) => i === 0 || sp.global[i - 1].gain >= e.gain), 'global not sorted desc');
  assert.ok(Math.abs(sp.global[0].weight - 1) < 1e-9, 'top weight must be 1.0');
  assert.ok(sp.bySlot.weapon.some((e) => e.match === 'lightning damage'), 'weapon can roll elementals');
  // 2026-08-20 widen: the 5 elementals are eligible on every slot now.
  assert.ok(sp.bySlot.boots.some((e) => e.match === 'lightning damage'), 'boots can roll elementals');
  assert.equal(sp.bySlot.boots.length, sp.bySlot.weapon.length, 'every slot has the same affix pool');
}

// Elementalist golems (combat.rs spawn_golem/thunder_golem_redirect): Thunder
// absorb pool raises ehp, Water regen creates hps from zero, and a tank-objective
// searchBuild must reach the golem cluster the ladder actually plays.
{
  const ele = tree.classes.Elementalist;
  const g = emptyBuckets();
  const bare = classScore('Elementalist', g, 231, model, { nodes: ele, alloc: {} });
  const thunder = classScore('Elementalist', g, 231, model,
    { nodes: ele, alloc: { golemmaster: 1, thundergolem: 1, gigantify: 3, growing: 3 } });
  assert.ok(thunder.ehp > bare.ehp * 2, 'thunder golem pool must raise ehp substantially');
  const water = classScore('Elementalist', g, 231, model,
    { nodes: ele, alloc: { golemmaster: 1, watergolem: 3, replenishing: 3 } });
  assert.equal(bare.hps, 0);
  assert.ok(water.hps > 0, 'water golem regen must produce hps');
  const tank = searchBuild('Elementalist', ele, 231, 231, model, { objective: (s) => s.ehp });
  assert.ok(tank.alloc.thundergolem > 0 && tank.alloc.golemmaster > 0, 'tank solve must take the thunder golem line');
}

// golem_summon_dmg_penalty was deleted from the game 2026-08-20: summoning
// golems must never reduce the owner's own damage. Each golem adds
// golemStatScale of the owner's output on top, so 3 golems reach ~1.99x.
{
  const ele = tree.classes.Elementalist;
  const g = { ...emptyBuckets(), weaponPower: 800 };
  const none = classScore('Elementalist', g, 231, model, { nodes: ele, alloc: {} });
  const three = classScore('Elementalist', g, 231, model, { nodes: ele, alloc: { golemmaster: 3 } });
  assert.ok(three.dps > none.dps, 'golems must never cost the owner damage');
  const expected = none.dps * (1 + 3 * model.rules.golemStatScale);
  assert.ok(Math.abs(three.dps / expected - 1) < 1e-9, `3 golems: ${three.dps} vs ${expected}`);
  assert.equal(model.rules.golemDmgPenaltyPer, undefined, 'the removed penalty must not come back');
}

// Righteous Fire is a plain multiplicative damage layer since 2026-08-20
// (combat.rs:4260, raw_dmg *= 1 + righteousfire_pct). Asserted against the
// node's own live magnitude, not a literal: RF carries a streamer override
// (passive_overrides.rs) that is currently 1000x its compiled default, and
// the game reads the override — so a hardcoded 1.3 here would be testing the
// source's default rather than what the ladder actually runs.
{
  const ele = tree.classes.Elementalist;
  const rfNode = ele.find((n) => n.key === 'righteousfire');
  const g = { ...emptyBuckets(), weaponPower: 800 };
  const off = classScore('Elementalist', g, 231, model, { nodes: ele, alloc: {} });
  const rf = classScore('Elementalist', g, 231, model, { nodes: ele, alloc: { righteousfire: 3 } });
  const expected = 1 + nodeMagnitude(rfNode, 3);
  assert.ok(Math.abs(rf.dps / off.dps - expected) < 1e-9, `RF 3/3: ${rf.dps / off.dps} vs ${expected}`);
  assert.ok(nodeScored(rfNode), 'righteousfire must score');
}

console.log('advisor-core tests passed');
