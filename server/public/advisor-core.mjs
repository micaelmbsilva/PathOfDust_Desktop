// Advisor scoring core — closed-form class evaluation grounded in PathofDust
// source math (see game-model.json's src cites). Pure functions, no DOM, so
// node can test it directly. Ruleset: ≤4 crafted mods per item + 1 Sacred,
// no uniques/shards, no krangle/crit-bonus extras.
//
// The passive tree IS modeled now (passive-tree.json, generated from
// src/passive_tree.rs): every FlatStat node, every OverflowConversion node,
// and the bespoke Special nodes that the character sheet's own combat_*
// getters read by key. Special nodes that only exist inside simulate_battle
// (procs, stacking buffs, shields, reflects, party broadcasts) are out of
// scope for a closed-form score — see UNMODELED_NOTE.

const BUCKETS = ['dr', 'block', 'evasion', 'intervene', 'inc', 'critChance', 'critMult',
  'splash', 'linger', 'leech', 'incLife', 'flatLife',
  'elemCold', 'elemFire', 'elemLightning', 'elemDivine', 'elemChaos'];
const ELEMS = ['elemCold', 'elemFire', 'elemLightning', 'elemDivine', 'elemChaos'];

export const UNMODELED_NOTE = 'Per-fight mechanics (Frenzy/Twin Strikes multi-strike, shields, '
  + 'reflects, stacking speed/damage buffs, marks and curses, Retaliation counters, Bloodpact, '
  + 'FlickerStrike) are real in combat but not in this closed-form score — treat them as upside. '
  + 'Real bosses also deal unmitigable boss_pierce_pct damage (bypasses evasion/block/DR, ramps with '
  + 'stage) not in eHP here — so eHP is optimistic against high-stage bosses.';

// Rust PassiveStat → the bucket name used here.
const TREE_STAT = {
  DamageReduction: 'dr', BlockChance: 'block', Evasion: 'evasion', IntervenePct: 'intervene',
  IncreasedDamage: 'inc', CritChance: 'critChance', CritMultiplier: 'critMult', Splash: 'splash',
  HealPowerPct: 'healPower', LifeLeechPct: 'leech', AttackSpeed: 'attackSpeed', MaxHpPct: 'incLife',
};
const OVERFLOW_CAP = { dr: 0.75, block: 0.75, evasion: 0.75, intervene: 0.5 };

// The `special` tree nodes classScore actually reads by key (via mag()/rank()).
// KEEP IN SYNC with the mag('…')/rank('…') references in classScore below — any
// special node NOT here is a per-fight mechanic (reflect, proc, multi-strike,
// curse…) the closed-form can't value, so it scores 0.
export const MODELED_SPECIAL_KEYS = new Set(['barrier', 'bloomingfield', 'colossus',
  'deadeye', 'deathwish', 'evergrowth', 'gloryhound', 'grimresolve', 'ironbark', 'juggernaut',
  'lifetap', 'momentousblow', 'overgrowth', 'overwhelmingforce', 'primalforce', 'reckless',
  'recklessabandon', 'regrowth', 'secondskin', 'soulexchange', 'titansgrip', 'wildsurge',
  'golemmaster', 'thundergolem', 'flamegolem', 'watergolem', 'gigantify', 'growing',
  'terrifying', 'replenishing', 'righteousfire']);

// Does the closed-form put a number on this node? FlatStat nodes mapped to a
// bucket and OverflowConversion nodes are modeled generically; Special nodes only
// if hand-wired (MODELED_SPECIAL_KEYS). 'none' nodes are structural (they unlock
// children), not scored. Used to tag "in-fight effect — not scored" in the tree.
export function nodeScored(node) {
  const e = node && node.effect;
  if (!e) return false;
  if (e.kind === 'flatStat') return !!TREE_STAT[e.stat];
  if (e.kind === 'overflowConversion') return true;
  if (e.kind === 'special') return MODELED_SPECIAL_KEYS.has(node.key);
  return false; // 'none'
}

export function emptyBuckets() {
  const b = { attackSpeed: 0, weaponPower: 0, bodyPower: 0, helmPower: 0, helmCooldownMs: 0, unparsed: 0 };
  for (const k of BUCKETS) b[k] = 0;
  return b;
}

// "+18% crit chance" → { bucket, value } (fraction for %, raw for flat). Null if unknown.
export function parseMod(text, model) {
  const t = String(text || '').toLowerCase().replace(/^sacred:\s*/, '');
  const m = t.match(/([\d.]+)\s*(%?)/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  // Longest-match-wins ordering is baked into model.affixes (crit dmg dealt
  // before dmg dealt, etc.) — first hit is the right one.
  for (const a of model.affixes) {
    if (!t.includes(a.match)) continue;
    if (a.flatBucket && !m[2]) return { bucket: a.flatBucket, value, perTier: a.flatPerTier };
    return { bucket: a.bucket, value: m[2] ? value / 100 : value, perTier: a.perTier };
  }
  return null;
}

// One item → buckets. Enforces the ruleset: krangled items keep only their
// best 4 crafted mods (by tier-equivalents); non-Sacred implicits (uniques)
// are skipped entirely.
export function parseItem(item, model) {
  const out = emptyBuckets();
  if (!item) return out;
  const slot = String(item.slot || '').toLowerCase();
  out.tier = +String(item.tier || '').replace(/\D/g, '') || 0;
  let mods = (Array.isArray(item.mods) ? item.mods : [])
    .map(m => parseMod(m && m.t, model)).filter(Boolean);
  if (item.krangled && mods.length > model.rules.modCap) {
    mods = mods.sort((a, z) => (z.value / z.perTier) - (a.value / a.perTier))
      .slice(0, model.rules.modCap);
  }
  for (const i of (Array.isArray(item.implicits) ? item.implicits : [])) {
    // The scraped line carries a "✦ " glyph prefix — match anywhere, not ^.
    if (!/sacred:/i.test(String(i && i.t || ''))) { continue; }
    const p = parseMod(i.t, model);
    if (p) mods.push(p);
  }
  for (const p of mods) out[p.bucket] += p.value;
  out.unparsed = (Array.isArray(item.mods) ? item.mods : []).filter(m => m && m.t && !parseMod(m.t, model)).length;
  const primary = String(item.primary || '');
  const pv = parseFloat((primary.match(/([\d.]+)/) || [])[1] || 0);
  if (/glove/.test(slot)) out.attackSpeed = /%/.test(primary) ? pv / 100 : pv;
  else if (/weapon/.test(slot)) out.weaponPower = pv;
  else if (/body/.test(slot)) out.bodyPower = pv;
  else if (/helm/.test(slot)) {
    // Helm power is dps-per-stack, gained every cooldown_ms (character.rs
    // helm_skill) — the cooldown curve is tier-driven, so derive it here.
    out.helmPower = pv;
    const c = model.rules.cooldownCurves.helm;
    out.helmCooldownMs = Math.max(c.floorMs, c.baseMs - out.tier * c.perTierMs);
  }
  return out;
}

export function sumBuckets(items) {
  const total = emptyBuckets();
  for (const it of items) {
    for (const k of Object.keys(total)) {
      // Cooldown is a rate, not a quantity — the last helm seen wins.
      if (k === 'helmCooldownMs') total[k] = it[k] || total[k];
      else total[k] += it[k] || 0;
    }
  }
  return total;
}

function archBonus(cls, level, model) {
  const raw = model.archetypes[cls] || {};
  const scale = 1 + level * model.archetypeLevelMult;
  const b = { role: raw.role || 'melee' };
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number') b[k] = v * scale;
  }
  return b;
}

// magnitude_at_rank (passive_tree.rs): a Specialization's 4th point only
// unlocks its children, it never grows the node's own stat.
export function nodeMagnitude(node, rank) {
  if (!node || !rank) return 0;
  const e = node.effect;
  if (!e || e.kind === 'none') return 0;
  const r = Math.min(rank, node.magnitudeCap);
  // `ranks` is present only on a node the streamer has retuned live (see
  // passive_overrides.rs; the export tool reads the published triplet off
  // /wiki/passives). It wins over r1/per because the running game uses it, and
  // it is an explicit per-rank list rather than a line: several live overrides
  // are not linear at all, and one is not even monotonic.
  if (e.ranks) return e.ranks[r - 1] ?? e.ranks[e.ranks.length - 1];
  return e.r1 + e.per * (r - 1);
}

// The tree's own two layers for one allocation: `flat` (pooled FlatStat
// nodes, plus Warrior's Colossus special-case) and `over` (OverflowConversion
// nodes, each drawing on COMBINED gear+tree overflow and hard-capped at
// 0.10 per invested rank). `gearRaw` is the gear+archetype raw value per
// capped stat, pre-cap. Mirrors Character::passive_bonus /
// passive_overflow_bonus.
export function treeLayer(nodes, alloc, gearRaw, model) {
  const flat = {}, over = {}, mag = {};
  const byKey = new Map((nodes || []).map(n => [n.key, n]));
  for (const [key, rank] of Object.entries(alloc || {})) {
    const n = byKey.get(key);
    if (!n || !rank) continue;
    mag[key] = nodeMagnitude(n, rank);
    if (n.effect.kind === 'flatStat') {
      const b = TREE_STAT[n.effect.stat];
      if (b) flat[b] = (flat[b] || 0) + mag[key];
    }
  }
  // Colossus multiplies Juggernaut's own max-hp bonus rather than adding a
  // flat number — the one cross-node lookup in the whole tree.
  const juggColossus = (mag.juggernaut || 0) * (mag.colossus || 0);
  if (juggColossus) flat.incLife = (flat.incLife || 0) + juggColossus;

  for (const [key, rank] of Object.entries(alloc || {})) {
    const n = byKey.get(key);
    if (!n || !rank || n.effect.kind !== 'overflowConversion') continue;
    const inB = TREE_STAT[n.effect.input], outB = TREE_STAT[n.effect.output];
    const cap = OVERFLOW_CAP[inB];
    if (cap == null || !outB) continue;
    const combined = (gearRaw[inB] || 0) + (flat[inB] || 0);
    const spill = Math.max(0, combined - cap);
    const raw = spill * mag[key];
    over[outB] = (over[outB] || 0) + Math.min(raw, model.rules.overflowConversionCapPerRank * rank);
  }
  return { flat, over, mag, juggColossus, get: (b) => (flat[b] || 0) + (over[b] || 0) };
}

// combine_reduction_sources (character.rs:794) — independent mitigation
// sources stack multiplicatively, never additively.
const combineSources = (sources) =>
  1 - sources.reduce((p, s) => p * (1 - Math.min(1, Math.max(-0.75, s))), 1);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Berserker's Reckless Swing / Death Wish: two rank-matched step functions
// each (combat.rs:3118-3150), not one linear formula.
const RECKLESS_DEALT = [0, 0.15, 0.25, 0.35], RECKLESS_TAKEN = [0, 0.08, 0.13, 0.18];
const DEATHWISH_DEALT = [0, 0.10, 0.20, 0.30], DEATHWISH_TAKEN = [0, 0.05, 0.10, 0.15];
const step = (table, rank) => table[Math.min(rank || 0, 3)];

// Closed-form power evaluation for one class over aggregated gear buckets at
// the player's level. Mirrors the game formulas cited in game-model.json.
// `tree` is optional: { nodes: passive-tree.json classes[cls], alloc: {key: rank} }.
export function classScore(cls, g, level, model, tree) {
  const R = model.rules, B = archBonus(cls, level, model);
  const role = R.roles[B.role];

  // Gear+archetype raw totals for the 4 capped stats — one SOURCE, before
  // its own cap and before the tree's separate source is combined in.
  const gearRaw = { dr: g.dr + (B.dr || 0), block: g.block + (B.block || 0),
    evasion: g.evasion + (B.evasion || 0), intervene: g.intervene + (B.intervene || 0) };
  const T = treeLayer(tree && tree.nodes, tree && tree.alloc, gearRaw, model);
  const rank = (k) => ((tree && tree.alloc && tree.alloc[k]) || 0);
  const mag = (k) => T.mag[k] || 0;

  // Each of the 4 capped stats: gear+archetype capped on its own, the tree
  // capped on its own, then combined multiplicatively (plus any bespoke
  // extra source). Gear alone tops out at 75%; gear+tree reaches 93.75%.
  const cap = R.capsPerSource;
  const sourceStat = (b, extra = []) => combineSources([
    clamp(gearRaw[b], cap[b][0], cap[b][1]),
    clamp(T.get(b), cap[b][0], cap[b][1]),
    ...extra,
  ]);
  // Reckless Swing/Death Wish's "taken" half is a NEGATIVE source; Reckless
  // Abandon offsets it. Druid's Thorned Barrier + Ironbark is its own source.
  const recklessTaken = -Math.max(0, step(RECKLESS_TAKEN, rank('reckless'))
    + step(DEATHWISH_TAKEN, rank('deathwish')) - mag('recklessabandon'));
  const eff = {
    dr: sourceStat('dr', [recklessTaken, mag('barrier') + mag('ironbark')]),
    block: sourceStat('block'),
    evasion: sourceStat('evasion'),
    // Intervene is the one capped stat with a hard ceiling on the COMBINED
    // total, not just per source (character.rs:2776, 2026-08-18 fix — two
    // 50%-capped sources were combining to 75%). DR and block have no such
    // ceiling and genuinely reach 93.75%+; evasion's own 95% clamp lives at
    // the resolve_hit roll instead, applied where `taken` is computed below.
    intervene: Math.min(0.5, sourceStat('intervene')),
  };

  // defensive_overflow: gear+archetype only, 1:1 into the gear layer of
  // increased damage. (The tree's OverflowConversion nodes draw again off the
  // same raw spill — deliberate, see game-model.json's overflow cite.)
  let overflow = 0;
  for (const b of ['dr', 'block', 'evasion', 'intervene']) {
    overflow += Math.max(0, gearRaw[b] - cap[b][1]) * R.overflowToInc;
  }

  // Flame Golem multiplies the OWNER's elemental-damage increases by
  // 1.33/1.66/2.0× (passive_tree.rs "flamegolem"; golems inherit the result,
  // which the per-golem output share below already reflects) — but only for
  // fire/cold/lightning: combat.rs:10623-10626 applies flamegolem_mult to
  // those three alone, chaos and divine are not "elemental" for this node.
  const fgMult = mag('flamegolem') || 1;
  const FG_ELEMS = new Set(['elemFire', 'elemCold', 'elemLightning']);
  const elemTotal = ELEMS.reduce((s, e) => s + g[e] * (FG_ELEMS.has(e) ? fgMult : 1), 0);
  // Every bespoke conversion is its own multiplicative layer, not a term in
  // the tree's additive pool (character.rs combat_increased_damage).
  const layers = [
    1 + g.inc + (B.inc || 0) + overflow + elemTotal,
    1 + T.get('inc'),
    1 + T.juggColossus * mag('titansgrip'),
    1 + Math.max(0, eff.dr) * (mag('overwhelmingforce') + mag('grimresolve')),
    1 + Math.max(0, eff.block) * mag('momentousblow'),
    1 + step(RECKLESS_DEALT, rank('reckless')),
    1 + step(DEATHWISH_DEALT, rank('deathwish')) + mag('gloryhound'),
    1 + mag('lifetap') * (2 + mag('soulexchange')),
    // Righteous Fire (combat.rs:4260 resolve_hit, raw_dmg *= 1 +
    // righteousfire_pct). Since 2026-08-20 this is a plain multiplicative
    // layer on every landed hit, splash included — it used to be its own
    // per-second true-damage tick, which the closed form couldn't value.
    // ponytail: RF's self-burn (rf_self_damage_pct, 10/20/30% of max HP per
    // second) is NOT charged against ehp, so an RF build scores optimistic.
    // Upgrade path: subtract it over assumedFightDurationMs once ehp has a
    // time-based term to spend it against.
    1 + mag('righteousfire'),
  ];
  const inc = Math.max(-0.9, layers.reduce((a, b) => a * b, 1) - 1);

  const cc = (R.critBase + g.critChance + (B.critChance || 0)) * (1 + T.get('critChance') + mag('deadeye'));
  const cm = Math.max(1, (R.critMultBase + g.critMult + (B.critMult || 0)) * (1 + T.get('critMult')));
  // Overcrit saturating curve (combat.rs crit_stack_bonus): first stack pays
  // the flat rate, stacks past it run through A*x/(x+h). Real stacks are
  // floor(cc) or floor(cc)+1, so the exact EV is the two-point mixture of the
  // (nonlinear) bonus at those whole values — not the bonus at E[stacks].
  const stackBonus = (s) => {
    const over = Math.max(0, s - 1);
    const curve = R.overcritCurveA * over / (over + R.overcritCurveH);
    return (Math.min(s, 1) + curve) * (cm - 1) * R.critBonusMult;
  };
  const ccFloor = Math.floor(cc), ccRem = cc - ccFloor;
  const critF = 1 + (1 - ccRem) * stackBonus(ccFloor) + ccRem * stackBonus(ccFloor + 1);

  // Proc chance is roll / elemProcDivisor, then clamped to 100% by the game
  // itself (combat.rs:7170 roll_elemental_proc) — raw past the divisor buys
  // nothing more on the proc side. The clamp matters now that all 5 slots can
  // roll elemental, so one element can genuinely saturate.
  const procF = 1 + ELEMS.reduce((s, e) =>
    s + Math.min(1, g[e] / R.elemProcDivisor) * (model.proxies.elemProcValue[e] || 0.5), 0);
  // Splash: each extra target takes min(splash, 1) of the hit, and crossing
  // 100% buys 2 more targets (apply_splash) — a step, not a linear ramp.
  const splash = Math.max(0, (1 + g.splash + (B.splash || 0)) * (1 + T.get('splash')) * (1 + mag('primalforce')) - 1);
  const splashTargets = Math.min(model.proxies.splashExpectedTargets,
    R.splashMaxTargets + (splash > 1 ? R.splashOverflowBonusTargets : 0));
  const aoeF = 1 + Math.min(splash, 1) * splashTargets * model.proxies.splashWeight;

  // Cadence: gear/archetype and tree speed are independent multiplicative
  // layers, then the heal-power-excess divisor (widened by Wild Surge +
  // Overgrowth). Healer divine self-buff loop (uncapped stacks, 1%/stack, 4s)
  // solved by fixed-point iteration — converges in a few rounds.
  const speedMult = (1 + g.attackSpeed + (B.attackSpeed || 0)) * (1 + T.get('attackSpeed'));
  const wildSurge = mag('wildsurge') + mag('overgrowth');
  // Heal-function classes get a 0.5 baseline; others rely on the archetype
  // bonus alone (combat_heal_power — Paladin's is real). Gear grants none.
  const healBaseline = (B.role === 'heal' ? R.healBase : 0) + (B.healPower || 0);
  const healOf = (divineStacks) => Math.max(0, (1 + healBaseline + divineStacks * R.divineHealBuffPerStack)
    * (1 + T.get('healPower')) * (1 + mag('regrowth')) * (1 + mag('bloomingfield')) - 1);
  const intervalOf = (hp) => Math.max(R.attackIntervalFloorMs,
    role.intervalMs / Math.max(0.01, speedMult) / (1 + Math.max(0, hp - 1) * (1 + wildSurge)));
  let healPower = healOf(0);
  let interval = intervalOf(healPower);
  // The divine self-buff fires from apply_heal, so anyone who heals at all
  // gets it — Paladin included, not just the two Heal-function archetypes.
  if (healPower > 0 && g.elemDivine > 0) {
    for (let i = 0; i < 6; i++) {
      const stacksAlive = Math.floor(g.elemDivine) * (R.elemProcDurationMs / interval);
      healPower = healOf(stacksAlive);
      interval = intervalOf(healPower);
    }
  }
  const rate = 1000 / interval;

  const baseHit = role.mult * (R.baseAtk[0] + R.baseAtk[1] * level) + role.flat + g.weaponPower;
  // The helm's stacking dps buff averaged over a 30s fight (half the stacks
  // it would reach by the end) — combat_total_output_per_sec.
  const helm = g.helmPower > 0 && g.helmCooldownMs > 0
    ? g.helmPower * (R.assumedFightDurationMs / g.helmCooldownMs) / 2 : 0;
  const lingerPct = g.linger + mag('evergrowth') * healPower;
  const lingerF = 1 + lingerPct * model.proxies.lingerWeight; // total DoT = unmitigated hit × linger%
  const output = (baseHit * rate + helm) * (1 + inc) * critF * procF * aoeF * lingerF;
  let dps = output * Math.max(0, 1 - healPower);
  let hps = output * clamp(healPower, 0, 1);

  const hp = (R.baseHp[0] + R.baseHp[1] * level + g.flatLife + g.bodyPower)
    * (1 + g.incLife + (B.incLife || 0)) * (1 + T.get('incLife'));
  // Second Skin overrides the flat 50% a block takes off a hit.
  const blockReduction = mag('secondskin') || R.blockDamageReduction;
  const taken = (1 - Math.min(0.95, eff.evasion)) * (1 - eff.dr) * (1 - eff.block * blockReduction);
  const leech = Math.max(0, (1 + g.leech + (B.leech || 0)) * (1 + T.get('leech')) - 1);
  const leechHps = Math.min(leech * dps, R.leechCapPerSec * hp);
  let ehp = hp / Math.max(0.01, taken) + leechHps * model.proxies.leechSeconds;

  // --- Elementalist golems (combat.rs spawn_golem / thunder_golem_redirect).
  // One golem per Golem Master rank. GOLEM_STAT_SCALE (0.33) applies ONLY to
  // atk/max_hp/evasion/damage_reduction/block_chance; since 2026-08-20 every
  // other multiplier the owner carries — splash and lingering included — is
  // inherited whole, and a golem reads the owner's LIVE speed stacks each
  // turn instead of a flat 1.0 snapshot. So each golem's output really is
  // ≈33% of the owner's, which is what `gs * output` says; it used to be an
  // over-estimate. The owner's own damage is NOT reduced by golem count any
  // more: golem_summon_dmg_penalty was deleted from the game outright (the
  // ~100x power jump at 3 golems is accepted design). The game's own
  // "golemmaster" node prose still describes the old penalty — it is stale in
  // the source; model the code. Golems are pure attackers (no heal share).
  // Golem TYPE is a character-page choice the tree can't see: assume one
  // golem of each invested type spec, which is how anyone paying those points
  // plays it.
  const golems = rank('golemmaster');
  if (golems) {
    const gs = R.golemStatScale;
    dps += golems * gs * output;
    // Thunder: absorbs ALL party-bound damage while alive and reforms on a
    // timer (4/3/2s — mag is the delay), Growing compounding its max hp each
    // reform. Closed form: the enemy must burn N incarnations' worth of pool
    // per fight before damage reaches you — N scales inversely with the
    // reform delay off the golemIncarnations proxy. The golem's own scaled
    // mitigation is ignored (conservative).
    if (rank('thundergolem')) {
      const gHp = hp * gs * (1 + mag('gigantify'));
      const N = model.proxies.golemIncarnations * 4 / Math.max(1, mag('thundergolem'));
      const grow = mag('growing');
      ehp += gHp * (N + grow * N * (N - 1) / 2);
      // Terrifying: every death explodes for a fraction of that incarnation's hp.
      dps += mag('terrifying') * gHp * (1 + grow * (N - 1) / 2) * N / (R.assumedFightDurationMs / 1000);
    }
    // Water: party regen of 3/6/9% of the golem's max hp per second
    // (non-stacking), plus Replenishing converting its damage to healing.
    if (rank('watergolem')) {
      hps += mag('watergolem') * hp * gs + mag('replenishing') * gs * output;
    }
  }

  // Healing is converted damage, so a healer's output is real party value —
  // score it alongside dps rather than reading as zero damage.
  return { score: (dps + hps) * Math.sqrt(ehp), dps, hps, ehp, hp, overflow, healPower, interval, splash, leech,
    detail: { inc, cc, cm, eff, taken, lingerPct, helm, unparsed: g.unparsed } };
}

// Points a level has earned (passive_tree.rs points_for_level).
export const pointsForLevel = (lv) => 1 + Math.floor(Math.max(0, +lv || 0) / 4);

// Ranks that must be bought before `key` is legal at all: a Specialization
// needs its Skill parent at 1, a Modifier needs its Specialization parent at
// 4 (manager.rs preview_allocate_passive).
function prereqs(byKey, alloc, key, want) {
  const need = new Map();
  const walk = (k, rank) => {
    const n = byKey.get(k);
    if (!n) return;
    const have = need.get(k) ?? alloc[k] ?? 0;
    if (have >= rank) return;
    need.set(k, rank);
    if (n.parent) walk(n.parent, byKey.get(n.parent).tier === 'spec' ? (n.unlockAt || 1) : 1);
  };
  walk(key, want);
  return need;
}

// Best tree allocation for `points` under `objective`. Greedy over BUNDLES
// ("take node X to rank r, buying whatever prerequisite ranks that needs")
// rather than single ranks — a Specialization's 4th point grows nothing on
// its own, so a rank-at-a-time greedy could never reach any Modifier.
//
// `spendAll` (advisor respec plans): once no positive-gain bundle remains, keep
// allocating the max-gain affordable bundle anyway — preferring harmless nodes
// (gain 0, incl. inert Skill/root nodes) over strictly harmful ones — until the
// whole point budget is spent or the tree is full. The theoretical optimizers
// (best-builds.mjs / searchBuild) leave it false: they want the best build, not
// a fully-drained tree.
export function bestTree(cls, nodes, g, level, model, points, objective = (s) => s.score, spendAll = false) {
  const byKey = new Map((nodes || []).map(n => [n.key, n]));
  const alloc = {};
  let left = points, base = objective(classScore(cls, g, level, model, { nodes, alloc }));
  while (left > 0) {
    let pick = null; // best positive-gain bundle, by rate (gain/cost)
    let fill = null; // spendAll fallback: max gain, tie-break lowest cost
    for (const n of nodes || []) {
      // Inert nodes do nothing on their own; only worth buying as a prereq
      // (which prereqs() handles) — except under spendAll, where they soak up
      // leftover points harmlessly.
      if (n.effect.kind === 'none' && !spendAll) continue;
      for (let want = (alloc[n.key] || 0) + 1; want <= n.max; want++) {
        const need = prereqs(byKey, alloc, n.key, want);
        let cost = 0;
        for (const [k, r] of need) cost += r - (alloc[k] || 0);
        if (cost <= 0 || cost > left) continue;
        const trial = { ...alloc };
        for (const [k, r] of need) trial[k] = r;
        const gain = objective(classScore(cls, g, level, model, { nodes, alloc: trial })) - base;
        if (gain > 0 && (!pick || gain / cost > pick.rate)) pick = { trial, cost, gain, rate: gain / cost };
        if (spendAll && (!fill || gain > fill.gain || (gain === fill.gain && cost < fill.cost)))
          fill = { trial, cost, gain };
      }
    }
    const chosen = pick || (spendAll ? fill : null);
    if (!chosen) break;
    Object.assign(alloc, chosen.trial);
    base += chosen.gain;
    left -= chosen.cost;
  }
  return { alloc, spent: points - left, value: base };
}

// Greedy bag-swap: for each bag item, take it over the equipped piece in its
// slot when the class score improves. Returns chosen items + swap advice.
export function bestLoadout(equipped, bag, cls, level, model, tree) {
  const chosen = new Map(); // slot → {item, parsed}
  for (const it of equipped || []) {
    const slot = String(it.slot || '').toLowerCase();
    chosen.set(slot, { item: it, parsed: parseItem(it, model) });
  }
  const swaps = [];
  const score = () => classScore(cls, sumBuckets([...chosen.values()].map(c => c.parsed)), level, model, tree).score;
  let cur = score();
  for (const it of bag || []) {
    if (it && it.unique) continue; // excluded ruleset
    const slot = String(it.slot || '').toLowerCase();
    if (!slot) continue;
    const prev = chosen.get(slot);
    chosen.set(slot, { item: it, parsed: parseItem(it, model) });
    const s = score();
    if (s > cur) { cur = s; swaps.push({ slot, use: it, over: prev && prev.item }); }
    else if (prev) chosen.set(slot, prev);
    else chosen.delete(slot);
  }
  return { items: [...chosen.values()].map(c => c.item), buckets: sumBuckets([...chosen.values()].map(c => c.parsed)), swaps, score: cur };
}

// Derived craft plan: per slot, the 4 crafted mods (+1 sacred wish across the
// set) with the biggest marginal class-score gain of one average roll. `tier`
// is a number, or a {slot: tier} map so each slot plans at the tier of the
// base item actually being crafted on (mods roll at ITEM tier). `empirical`
// (from api/affix-rates) overrides a model perTier when they disagree by
// >20% — covers a live balance-toml override.
export function rollTargets(cls, level, tier, model, baseBuckets, empirical, tree, objective = (s) => s.score) {
  const tierOf = (s) => (tier && typeof tier === 'object') ? (+tier[s] || 1) : (+tier || 1);
  const perTier = (a) => {
    const emp = empirical && empirical[a.match];
    return (emp && Math.abs(emp - a.perTier) / a.perTier > 0.2) ? emp : a.perTier;
  };
  const g = { ...emptyBuckets(), ...(baseBuckets || {}) };
  const slots = ['weapon', 'helm', 'body', 'gloves', 'boots'];
  const plan = Object.fromEntries(slots.map(s => [s, []]));
  const gain = (a, t, mult) => { // % variant targeted when crafting (flat max hp shares its label)
    const before = objective(classScore(cls, g, level, model, tree));
    const v = perTier(a) * t * (mult || 1);
    g[a.bucket] += v;
    const after = objective(classScore(cls, g, level, model, tree));
    g[a.bucket] -= v;
    return after - before;
  };
  for (const slot of slots) {
    const t = tierOf(slot);
    for (let pick = 0; pick < model.rules.modCap; pick++) {
      const eligible = model.affixes.filter(a =>
        (!a.slots || a.slots.includes(slot)) && !plan[slot].some(p => p.match === a.match));
      let best = null, bestGain = -1;
      for (const a of eligible) {
        const d = gain(a, t);
        if (d > bestGain) { bestGain = d; best = a; }
      }
      if (!best) break;
      plan[slot].push({ match: best.match, avg: perTier(best) * t });
      g[best.bucket] += perTier(best) * t;
    }
  }
  // One sacred wish: any affix, any slot, 1.38× an average max roll, dup
  // allowed — valued at the best tier among the slots.
  const maxT = Math.max(...slots.map(tierOf));
  let sacred = null, sacredGain = -1;
  for (const a of model.affixes) {
    const d = gain(a, maxT, model.rules.sacredMult);
    if (d > sacredGain) { sacredGain = d; sacred = { match: a.match, avg: perTier(a) * maxT * model.rules.sacredMult }; }
  }
  return { plan, sacred };
}

// Stat priority: rank every craftable affix by the marginal class-score gain of
// ONE average roll on top of the current build, so when a veil can't land the
// exact mod you know what to chase instead. `global` values each affix at its
// best eligible slot; `bySlot` values it per slot (no affix is slot-restricted
// today — the 5 elementals were, until the 2026-08-20 widen — but the model
// keeps `slots` so a future one can be). Mirrors rollTargets' gain(). `tier` is a number
// or a {slot:tier} map. Each list is sorted desc with weight = gain/topGain
// (1.0 = strongest); `capped` flags an affix whose marginal gain has gone
// near-zero (a defense already past its cap, only paying through overflow).
export function statPriority(cls, level, tier, model, baseBuckets, tree, objective = (s) => s.score) {
  const tierOf = (s) => (tier && typeof tier === 'object') ? (+tier[s] || 1) : (+tier || 1);
  const g = { ...emptyBuckets(), ...(baseBuckets || {}) };
  const slots = ['weapon', 'helm', 'body', 'gloves', 'boots'];
  const base = objective(classScore(cls, g, level, model, tree));
  const gainOf = (a, t) => {
    const v = a.perTier * t;
    g[a.bucket] += v;
    const after = objective(classScore(cls, g, level, model, tree));
    g[a.bucket] -= v;
    return after - base;
  };
  const withWeights = (list) => {
    list.sort((x, z) => z.gain - x.gain);
    const top = Math.max(1e-12, list[0] ? list[0].gain : 0);
    for (const e of list) { e.weight = Math.max(0, e.gain) / top; e.capped = e.gain <= top * 0.01; }
    return list;
  };
  const bySlot = {};
  for (const slot of slots) {
    const t = tierOf(slot);
    bySlot[slot] = withWeights(model.affixes
      .filter(a => !a.slots || a.slots.includes(slot))
      .map(a => ({ match: a.match, gain: gainOf(a, t), slots: a.slots || null })));
  }
  // Global: each affix at whichever eligible slot scores it highest.
  const best = new Map();
  for (const slot of slots) for (const e of bySlot[slot]) {
    const cur = best.get(e.match);
    if (!cur || e.gain > cur.gain) best.set(e.match, { match: e.match, gain: e.gain, slots: e.slots });
  }
  return { global: withWeights([...best.values()]), bySlot };
}

// Best reachable build for one class under the modeled ruleset (5 Perfect
// items, 4 crafted mods each + 1 Sacred, no uniques/krangle), jointly
// optimizing gear affixes and the passive tree for `objective`. Pure — the
// same math the site scores players with. Mirrors tools/best-builds.mjs, which
// now calls this. Constraints (opts):
//   require: [affix.match | affix.label ...] forced into gear, one copy each
//   ban:     [affix.match ...] never rolled (gear or Sacred)
//   objective: score selector, default s => s.score
export function searchBuild(cls, nodes, level, tier, model, opts = {}) {
  const R = model.rules;
  const objective = opts.objective || ((s) => s.score);
  const points = pointsForLevel(level);
  const require = opts.require || [];
  const ban = new Set(opts.ban || []);
  const SLOTS = ['weapon', 'helm', 'body', 'gloves', 'boots'];
  // A Perfect item: primary = base × tier × 1.2 (roll) × 1.2 (Perfect); every
  // affix = perTier × tier × 1.15 (max jitter) × 1.2 (Perfect) — the same 1.38×
  // a Sacred implicit gets.
  const PRIMARY = (slot) => R.slotBasePower[slot] * tier * R.powerRollRange[1] * R.perfectMult;
  const AFFIX = (a) => a.perTier * tier * R.affixJitter[1] * R.perfectMult;
  // "max hp" is two Rust affixes sharing a label (IncreasedLife %, FlatLife
  // raw) — split so the flat variant is pickable. Then drop banned affixes.
  const CHOICES = model.affixes.flatMap((a) => a.flatBucket
    ? [{ ...a, label: a.match + ' %' }, { match: a.match, label: a.match + ' flat', bucket: a.flatBucket, perTier: a.flatPerTier, slots: a.slots }]
    : [{ ...a, label: a.match }])
    .filter((a) => !ban.has(a.match) && !ban.has(a.label));
  const eligible = (slot) => CHOICES.filter((a) => !a.slots || a.slots.includes(slot));
  // Required affixes, resolved once and ordered most-constrained-first (fewest
  // eligible slots) so a scarce elemental slot isn't eaten by an unrestricted
  // requirement placed earlier. Unresolvable names are dropped here silently;
  // ones that resolve but can't fit are reported via `dropped` below.
  const reqAffixes = require
    .map((req) => CHOICES.find((c) => c.label === req || c.match === req))
    .filter(Boolean)
    .sort((a, b) => (a.slots ? a.slots.length : SLOTS.length) - (b.slots ? b.slots.length : SLOTS.length));

  const baseGear = () => {
    const g = emptyBuckets();
    g.weaponPower = PRIMARY('weapon'); g.bodyPower = PRIMARY('body');
    g.attackSpeed = PRIMARY('gloves'); g.helmPower = PRIMARY('helm');
    const c = R.cooldownCurves.helm;
    g.helmCooldownMs = Math.max(c.floorMs, c.baseMs - tier * c.perTierMs);
    return g;
  };

  // Greedy fill of the 20 crafted slots (4 × 5 items) + 1 Sacred for one
  // objective, given a fixed tree. Required affixes are placed first.
  function bestGear(alloc) {
    const g = baseGear();
    const left = Object.fromEntries(SLOTS.map((s) => [s, R.modCap]));
    const picks = Object.fromEntries(SLOTS.map((s) => [s, []]));
    const t = { nodes, alloc };
    const value = () => objective(classScore(cls, g, level, model, t));
    // Force required affixes — one copy each into an eligible slot with room.
    // Elemental affixes only fit weapon/helm; a requirement with no room left
    // is recorded in `dropped` so the caller can warn instead of failing quiet.
    const dropped = [];
    for (const a of reqAffixes) {
      const slot = SLOTS.find((s) => left[s] > 0 && eligible(s).includes(a));
      if (!slot) { dropped.push(a.label); continue; }
      g[a.bucket] += AFFIX(a); picks[slot].push(a.label); left[slot]--;
    }
    let cur = value();
    for (let n = 0; n < SLOTS.length * R.modCap; n++) {
      let pick = null;
      for (const slot of SLOTS) {
        if (!left[slot]) continue;
        for (const a of eligible(slot)) {
          const v = AFFIX(a);
          g[a.bucket] += v; const gain = value() - cur; g[a.bucket] -= v;
          if (gain > 0 && (!pick || gain > pick.gain)) pick = { slot, a, v, gain };
        }
      }
      if (!pick) break;
      g[pick.a.bucket] += pick.v; picks[pick.slot].push(pick.a.label); left[pick.slot]--; cur += pick.gain;
    }
    // The one Sacred: any affix, any slot, same 1.38× value, may duplicate.
    let sac = null;
    for (const a of CHOICES) {
      const v = AFFIX(a);
      g[a.bucket] += v; const gain = value() - cur; g[a.bucket] -= v;
      if (!sac || gain > sac.gain) sac = { a, v, gain };
    }
    if (sac) g[sac.a.bucket] += sac.v;
    return { g, picks, sacred: sac ? sac.a.label : null, dropped };
  }

  // Gear and tree each change what the other is worth (overflow conversions,
  // Titan's Grip, the divine heal loop), so alternate until it settles.
  let alloc = {}, gear = bestGear(alloc);
  for (let i = 0; i < 4; i++) {
    const t = bestTree(cls, nodes, gear.g, level, model, points, objective);
    const next = bestGear(t.alloc);
    const settled = objective(classScore(cls, next.g, level, model, { nodes, alloc: t.alloc }))
      <= objective(classScore(cls, gear.g, level, model, { nodes, alloc })) * 1.0001;
    alloc = t.alloc; gear = next;
    if (settled) break;
  }
  return { cls, alloc, gear, score: classScore(cls, gear.g, level, model, { nodes, alloc }), dropped: gear.dropped };
}

// Passive order trimmed to the level's point budget (1 + floor(level/4)).
export function trimOrder(order, points) {
  const out = [];
  let left = points;
  for (const o of order || []) {
    if (left <= 0) break;
    const r = Math.min(+o.r || 0, left);
    if (r > 0) out.push({ n: o.n, r });
    left -= r;
  }
  return out;
}
