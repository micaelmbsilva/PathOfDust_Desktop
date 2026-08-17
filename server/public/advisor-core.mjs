// Advisor scoring core — closed-form class evaluation grounded in PathofDust
// source math (see game-model.json's src cites). Pure functions, no DOM, so
// node can test it directly. Ruleset: ≤4 crafted mods per item + 1 Sacred,
// no uniques/shards, no krangle/crit-bonus extras.
// ponytail: passive-tree magnitudes are prose-only in passives.json, so the
// tree layer is not modeled — class deltas from tree engines ride on the
// watchlist bonus. Upgrade path: machine-readable node magnitudes.

const BUCKETS = ['dr', 'block', 'evasion', 'intervene', 'inc', 'critChance', 'critMult',
  'splash', 'linger', 'leech', 'incLife', 'flatLife',
  'elemCold', 'elemFire', 'elemLightning', 'elemDivine', 'elemChaos'];
const ELEMS = ['elemCold', 'elemFire', 'elemLightning', 'elemDivine', 'elemChaos'];

export function emptyBuckets() {
  const b = { attackSpeed: 0, weaponPower: 0, bodyPower: 0, unparsed: 0 };
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
  return out;
}

export function sumBuckets(items) {
  const total = emptyBuckets();
  for (const it of items) {
    for (const k of Object.keys(total)) total[k] += it[k] || 0;
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

// Closed-form power evaluation for one class over aggregated gear buckets at
// the player's level. Mirrors the game formulas cited in game-model.json.
export function classScore(cls, g, level, model) {
  const R = model.rules, B = archBonus(cls, level, model);
  const role = R.roles[B.role];

  // Capped defenses; the spill feeds increased damage 1:1 (defensive_overflow).
  const caps = { dr: [g.dr + (B.dr || 0), 0.75], block: [g.block + (B.block || 0), 0.75],
    evasion: [g.evasion + (B.evasion || 0), 0.75], intervene: [g.intervene + (B.intervene || 0), 0.5] };
  let overflow = 0; const eff = {};
  for (const [k, [raw, cap]] of Object.entries(caps)) {
    eff[k] = Math.min(raw, cap);
    overflow += Math.max(0, raw - cap) * R.overflowToInc;
  }

  const elemTotal = ELEMS.reduce((s, e) => s + g[e], 0);
  const inc = g.inc + (B.inc || 0) + overflow + elemTotal;

  const cc = R.critBase + g.critChance + (B.critChance || 0);
  const cm = R.critMultBase + g.critMult + (B.critMult || 0);
  const critF = 1 + cc * (cm - 1) * R.critBonusMult; // E[stacks] = cc, uncapped

  const procF = 1 + ELEMS.reduce((s, e) => s + (g[e] / R.elemProcDivisor) * (model.proxies.elemProcValue[e] || 0.5), 0);
  const aoeF = 1 + (g.splash + (B.splash || 0)) * model.proxies.splashWeight;
  const lingerF = 1 + g.linger * model.proxies.lingerWeight; // total DoT = unmitigated hit × linger%

  // Cadence: gear/archetype speed layer, then the heal-power-excess divisor.
  // Healer divine self-buff loop (uncapped stacks, 1%/stack, 4s) solved by
  // fixed-point iteration — converges in a few rounds.
  const as = g.attackSpeed + (B.attackSpeed || 0);
  // Heal-function classes get a 0.5 baseline; others rely on the archetype
  // bonus alone (combat_heal_power, character.rs:2831-2837 — Paladin's is real).
  let healPower = (B.role === 'heal' ? R.healBase : 0) + (B.healPower || 0);
  let interval = role.intervalMs / (1 + as);
  if (B.role === 'heal' && g.elemDivine > 0) {
    for (let i = 0; i < 6; i++) {
      const stacksAlive = Math.floor(g.elemDivine) * (R.elemProcDurationMs / Math.max(R.attackIntervalFloorMs, interval));
      healPower = R.healBase + (B.healPower || 0) + stacksAlive * R.divineHealBuffPerStack;
      interval = role.intervalMs / (1 + as) / (1 + Math.max(0, healPower - 1));
    }
  } else {
    interval = interval / (1 + Math.max(0, healPower - 1));
  }
  interval = Math.max(R.attackIntervalFloorMs, interval);
  const rate = 1000 / interval;

  const baseHit = role.mult * (R.baseAtk[0] + R.baseAtk[1] * level) + role.flat + g.weaponPower;
  const dps = baseHit * (1 + inc) * critF * procF * aoeF * lingerF * rate;

  const hp = (R.baseHp[0] + R.baseHp[1] * level + g.flatLife + g.bodyPower) * (1 + g.incLife + (B.incLife || 0));
  const taken = (1 - eff.dr) * (1 - eff.block * R.blockDamageReduction) * (1 - eff.evasion);
  const leechHps = Math.min((g.leech + (B.leech || 0)) * dps, R.leechCapPerSec * hp);
  const ehp = hp / Math.max(0.01, taken) + leechHps * model.proxies.leechSeconds;

  return { score: dps * Math.sqrt(ehp), dps, ehp, overflow, healPower, interval,
    detail: { inc, cc, cm, eff, unparsed: g.unparsed } };
}

// Greedy bag-swap: for each bag item, take it over the equipped piece in its
// slot when the class score improves. Returns chosen items + swap advice.
export function bestLoadout(equipped, bag, cls, level, model) {
  const chosen = new Map(); // slot → {item, parsed}
  for (const it of equipped || []) {
    const slot = String(it.slot || '').toLowerCase();
    chosen.set(slot, { item: it, parsed: parseItem(it, model) });
  }
  const swaps = [];
  const score = () => classScore(cls, sumBuckets([...chosen.values()].map(c => c.parsed)), level, model).score;
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
export function rollTargets(cls, level, tier, model, baseBuckets, empirical) {
  const tierOf = (s) => (tier && typeof tier === 'object') ? (+tier[s] || 1) : (+tier || 1);
  const perTier = (a) => {
    const emp = empirical && empirical[a.match];
    return (emp && Math.abs(emp - a.perTier) / a.perTier > 0.2) ? emp : a.perTier;
  };
  const g = { ...emptyBuckets(), ...(baseBuckets || {}) };
  const slots = ['weapon', 'helm', 'body', 'gloves', 'boots'];
  const plan = Object.fromEntries(slots.map(s => [s, []]));
  const gain = (a, t, mult) => { // % variant targeted when crafting (flat max hp shares its label)
    const before = classScore(cls, g, level, model).score;
    const v = perTier(a) * t * (mult || 1);
    g[a.bucket] += v;
    const after = classScore(cls, g, level, model).score;
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
