// Personal combat-feed renderer, shared by the Live Fight panel, Combat
// History, the pop-out log, and Fight History.
//
// The feed is already reduced to "things involving you" when it's built (see
// startFight in index.html): only events where you are the attacker, target,
// healer or the unit itself survive, grouped into 1-second sim-time buckets.
// This module only renders those groups — it never decides what's in them.
//
// The category filter is persisted by the caller, since the two pages keep
// settings differently; pass the current value in and hand back the clicks.
(function () {
  const CSS = `
  .pod-feed { overflow-y: auto; border-top: 1px solid rgba(160,140,255,0.18); padding-top: 4px; }
  .pod-feed .fl { font-size: 0.76rem; padding: 1px 0; }
  .pod-feed .fl .ft { color: #8a7fb0; font-variant-numeric: tabular-nums; margin-right: 6px; }
  .pod-feed .fl.taken { color: #ff9d9d; }
  .pod-feed .fl.healed, .pod-feed .fl.healout { color: #7fdba3; }
  .pod-feed .fl.death { color: #ff8080; font-weight: 700; }
  .pod-feed .fl.myevaded, .pod-feed .fl.dodged { color: #9ad4d4; }
  .pod-feed .fl.shielded, .pod-feed .fl.shieldout { color: #82aaff; }
  .pod-feed .fl.buffgain { color: #c792ea; }
  .pod-feed .fl.bufflost { color: #8a7fb0; }
  .pod-feed .fl .mit { color: #8a7fb0; font-size: 0.92em; }
  /* Live panels add .stream: lines are appended one at a time there, so each
     one eases in instead of the block appearing at once. A batch view (history,
     a saved log) renders everything in one go and gets no animation. */
  .pod-feed.stream .fl { animation: pod-fl-in 150ms ease-out; }
  @keyframes pod-fl-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .pod-feed.stream .fl { animation: none; } }`;
  if (!document.getElementById('pod-feed-css')) {
    const s = document.createElement('style');
    s.id = 'pod-feed-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtN = (n) => n >= 1e12 ? (n / 1e12).toFixed(1) + 'T' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
  // Timestamps are the server's compressed replay clock (the whole fight is
  // rescaled into a 6-35s window before broadcast), not wall time.
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtT = (ms) => ms < 1000 ? Math.round(ms) + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : mmss(ms);
  const buffNames = (g) => (g.names || []).map(k => { const b = buff(k);
    return `${KIND_ICON[b.kind]} ${esc(b.label)}`; }).join(', ');
  // Only worth showing when it's a meaningful slice of the hit.
  const mitTxt = (g, who) => g.mit > (g.dmg + g.mit) * 0.02
    ? ` <span class="mit">(${fmtN(g.mit)} absorbed by ${who})</span>` : '';

  const FLINE = {
    hit: (g) => `⚔️ You → ${esc(g.tgt)}: <b>${fmtN(g.dmg)}</b>${g.n > 1 ? ` (${g.n} hits${g.crits ? `, ${g.crits} crit` : ''})` : g.crits ? ' (crit)' : ''}${mitTxt(g, 'their defenses')}`,
    myevaded: (g) => `🌫️ ${esc(g.tgt)} evaded you${g.n > 1 ? ` ×${g.n}` : ''}`,
    dodged: (g) => `🌀 You evaded ${esc(g.src)}${g.n > 1 ? ` ×${g.n}` : ''}`,
    taken: (g) => `🩸 ${esc(g.src)} → you: <b>${fmtN(g.dmg)}</b>${g.n > 1 ? ` (${g.n} hits)` : ''}${mitTxt(g, 'your defenses')}`,
    healed: (g) => `💚 ${esc(g.src)} healed you <b>${fmtN(g.amt)}</b>`,
    healout: (g) => `💚 You healed ${esc(g.tgt)} <b>${fmtN(g.amt)}</b>`,
    shielded: (g) => `🛡️ ${esc(g.src)} shielded you <b>${fmtN(g.amt)}</b>`,
    shieldout: (g) => `🛡️ You shielded ${esc(g.tgt)} <b>${fmtN(g.amt)}</b>`,
    buffgain: (g) => `✨ Gained: <b>${buffNames(g)}</b>`,
    bufflost: (g) => `🕯️ Wore off: ${buffNames(g)}`,
    death: () => `💀 You were defeated`,
  };

  // What every buffSnapshot key actually is, taken from active_buffs_snapshot
  // in the game's combat.rs rather than guessed from the name — several read
  // the opposite way round to how they sound. `wound_stacks` is the defender's
  // side of Slayer's Open Wound, so it is something done TO you; the "_bonus"
  // suffix is a buff in some keys and a penalty in others.
  //   kind: 'buff'  — your own build working
  //         'debuff'— something the enemy put on you
  //         'charge'— a pool or counter of yours, neither good nor bad
  // Each entry: label, kind, origin, what it does, and which skills grant it.
  //
  // `origin` is the part that cannot be guessed from the name. A shield is not
  // evidence your own build is working: grant_shield is called both as
  // (self, self) by Arcane Shield / Frenzy / Vengeful Blood and as
  // (healer, target) by Divine Favor / Overflowing Grace / Seed of Life, so a
  // shield on you may well be a Cleric keeping you alive. Likewise Fire, Cold
  // and Chaos's on-heal buffs are ally-targeted while Divine's lands on the
  // healer themselves — the opposite way round to the other three.
  //   origin: 'self'  — only your own kit can produce it
  //           'party' — an ally can grant it (several are self-castable too)
  //           'enemy' — put on you by whatever you are fighting
  //           'own'   — your own pool or counter
  const BUFFS = {
    // only your own kit
    speed_stacks: ['Attack Speed Stacks', 'buff', 'self', 'Stacking attack speed, built up by landing hits.', 'Momentum / Fleetfoot / Bloodlust / Relentless Pursuit / Flow State'],
    flowing_stacks: ['Flowing Strikes', 'buff', 'self', 'Stacks as you keep attacking without pause.', 'Monk — Flowing Strikes'],
    fel_rush_speed_bonus: ['Fel Rush', 'buff', 'self', 'Bonus attack speed.', 'Warlock — Fel Rush'],
    blood_frenzy_speed_bonus: ['Blood Frenzy', 'buff', 'self', 'Bonus attack speed.', 'Slayer — Blood Frenzy'],
    endless_thirst_cap_bonus: ['Endless Thirst', 'buff', 'self', 'Raises your life-leech ceiling. A value of 1 means the cap is off entirely (rank 3).', 'Slayer — Endless Thirst'],
    elemental_overflow_dmg_bonus: ['Elemental Overflow', 'buff', 'self', 'Elemental stacks past their cap, converted into bonus damage.', 'Warrior — Unbreakable / Druid — Shifting Form'],
    divine_heal_power_buff_stacks: ['Divine — Healing Power', 'buff', 'self', 'Divine damage invested while you heal buffs your own healing. Uncapped. Unlike the other three elements, this one lands on the healer rather than the target.', 'Divine elemental procs on your own heals'],
    // an ally can be the source
    shield_hp: ['Shield', 'buff', 'party', 'A pool that absorbs damage before your health does. May have been cast on you by an ally, or generated by your own skills.', 'Allies: Divine Favor / Overflowing Grace / Seed of Life · Yours: Arcane Shield / Frenzy / Vengeful Blood / Eternal Hunger / Overflow Vessel'],
    temp_heal_power_bonus: ['Healing Power', 'buff', 'party', 'Temporary boost to the healing you do.', 'Allies: Rising Tide / Healing Touch · Yours: Eternal Light'],
    temp_damage_reduction_bonus: ['Damage Reduction', 'buff', 'party', 'Temporary reduction to the damage you take.', 'Allies: Harmonize / Unbreakable Bond · Serenity'],
    fire_dr_buff_stacks: ['Fire — Damage Reduction', 'buff', 'party', 'Bonus damage reduction, granted when an ally heals you with Fire damage invested.', "An ally's Fire elemental procs"],
    cold_evasion_buff_stacks: ['Cold — Evasion', 'buff', 'party', 'Bonus evasion, granted when an ally heals you with Cold damage invested.', "An ally's Cold elemental procs"],
    chaos_block_buff_stacks: ['Chaos — Block', 'buff', 'party', 'Bonus block chance, granted when an ally heals you with Chaos damage invested.', "An ally's Chaos elemental procs"],
    // ambiguous by nature
    // Deliberately NOT filed under debuffs. Lingering Effect is symmetric:
    // a landed hit leaves a DoT on the enemy struck, a landed heal leaves an
    // equivalent HoT on the ally healed (LingeringDot.is_heal). The snapshot
    // reports one count for both, so an entry here may be an ally's heal
    // ticking on you just as easily as an enemy's damage.
    lingering_dot_count: ['Lingering Effects', 'mixed', 'mixed', 'Independent Lingering Effect instances ticking on you. Each is either damage-over-time from something that hit you, or heal-over-time from an ally who healed you — the game reports a single count and does not say which. Your OWN Lingering Effect stat is the opposite direction: it puts these on whatever you hit or heal.', 'Lingering Effect (Healing Power gear affix), from either side'],
    // put on you by the enemy
    wound_stacks: ['Open Wound', 'debuff', 'enemy', "A stacking bleed on you — this is the defender's side of the effect.", 'Open Wound'],
    marked: ['Marked', 'debuff', 'enemy', 'You were singled out on the first hit. Persists for the rest of the fight, with no expiry.', 'Mark'],
    curse_dmg_taken_bonus: ['Curse of Weakness', 'debuff', 'enemy', 'You take extra damage. Persists for the rest of the fight.', 'Curse of Weakness'],
    temp_damage_dealt_debuff: ['Damage Dealt Reduced', 'debuff', 'enemy', 'Your outgoing damage is cut.', 'Purify / Scorched Earth'],
    temp_evasion_debuff: ['Evasion Reduced', 'debuff', 'enemy', 'You dodge less often.', 'Frost Nova'],
    fire_dr_debuff_stacks: ['Fire — DR Lowered', 'debuff', 'enemy', 'Your damage reduction is cut.', 'Fire elemental procs'],
    cold_evasion_debuff_stacks: ['Cold — Evasion Lowered', 'debuff', 'enemy', 'Your evasion is cut.', 'Cold elemental procs'],
    chaos_block_debuff_stacks: ['Chaos — Block Lowered', 'debuff', 'enemy', 'Your block chance is cut.', 'Chaos elemental procs'],
    lightning_dmg_taken_stacks: ['Lightning — Damage Taken', 'debuff', 'enemy', 'You take extra damage.', 'Lightning elemental procs'],
    divine_heal_reduction_stacks: ['Divine — Healing Cut', 'debuff', 'enemy', 'Healing landing on you is reduced.', 'Divine elemental procs'],
    // your own pools and counters
    bloodpact_uses_this_fight: ['Bloodpact Used', 'charge', 'own', 'How many times Bloodpact has fired this fight. It runs on a cooldown, so this counts up rather than down.', 'Bloodpact'],
    guardian_spirit_charges_remaining: ['Guardian Spirit', 'charge', 'own', 'Charges left this fight.', 'Guardian Spirit'],
    assassinate_charges_remaining: ['Assassinate', 'charge', 'own', 'Charges left this fight.', 'Assassinate'],
    undying_will_charges_remaining: ['Undying Will', 'charge', 'own', 'Charges left this fight.', 'Undying Will'],
  };
  const prettyKey = (k) => String(k).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  // Unknown keys degrade to a readable name and no claim about what they are:
  // a new mechanic must not be called a buff just because we have not met it.
  const buff = (k) => { const b = BUFFS[k];
    return b ? { key: k, label: b[0], kind: b[1], origin: b[2], desc: b[3], from: b[4] }
      : { key: k, label: prettyKey(k), kind: 'unknown', origin: 'unknown', desc: '', from: '' }; };
  const KIND_ICON = { buff: '🟢', debuff: '🔴', charge: '🔵', mixed: '🟡', unknown: '⚪' };

  // Role comes from the class's kit, never inferred from a fight's numbers —
  // a healer who out-damages the party is still a healer. Dual-role classes
  // count in both. Shared so the Party panel and Fight History can't drift.
  const ROLE_ICON = { dps: '🗡️', heal: '🩹', tank: '🛡️' };
  const CLASS_ROLES = { Warrior: ['tank', 'dps'], Paladin: ['heal', 'tank'], Druid: ['heal', 'tank'],
    Monk: ['dps', 'tank'], Cleric: ['heal'] };
  const rolesOf = (cls) => cls ? (CLASS_ROLES[cls] || ['dps']) : null; // null = class unknown

  const CATS = { dmg: ['hit', 'taken', 'myevaded', 'dodged', 'death'],
    heals: ['healed', 'healout', 'shielded', 'shieldout'], buffs: ['buffgain', 'bufflost'] };
  const CHIPS = [['all', 'All'], ['dmg', '⚔️ Damage'], ['heals', '💚 Heals'], ['buffs', '✨ Buffs']];
  const passes = (g, cat) => !cat || cat === 'all' || (CATS[cat] || []).includes(g.kind);

  const chips = (cat) => `<div class="rolechips fchips">` + CHIPS.map(([v, l]) =>
    `<span class="chip pf${(cat || 'all') === v ? ' on' : ''}" data-fcat="${v}">${esc(l)}</span>`).join('') + '</div>';

  // filter -> collapse identical consecutive lines. Split from rendering so a
  // live panel can append one group at a time (and re-render just the line it
  // collapsed into) instead of rebuilding the whole list per repaint.
  const COLLAPSE_MS = 2000; // a repeat minutes later is its own event, not a ×N
  function entries(groups, cat) {
    const out = [];
    for (const g of groups || []) {
      if (!passes(g, cat) || !FLINE[g.kind]) continue;
      const txt = FLINE[g.kind](g);
      const prev = out[out.length - 1];
      if (prev && prev.txt === txt && (g.at || 0) - (prev.lastAt || 0) <= COLLAPSE_MS) { prev.n++; prev.lastAt = g.at; continue; }
      out.push({ at: g.at, lastAt: g.at, kind: g.kind, txt, n: 1 });
    }
    return out;
  }
  // True when `e` should fold into the already-rendered line `prev` — the same
  // test entries() applies inside a batch, exposed for the incremental path.
  const folds = (prev, e) => !!prev && prev.txt === e.txt && (e.at || 0) - (prev.lastAt || 0) <= COLLAPSE_MS;
  // The repeat count is its own node (.fn) so a live panel can bump it in place
  // — re-rendering the whole line would replay its enter animation on every
  // repeat, which flickers.
  const render = (es) => es.map(l =>
    `<div class="fl ${l.kind}"><span class="ft">${fmtT(l.at)}</span>${l.txt}${l.n > 1 ? ` <b class="fn">×${l.n}</b>` : ''}</div>`).join('');
  const lines = (groups, cat) => render(entries(groups, cat));

  const bindChips = (root, onPick) => root.querySelectorAll('[data-fcat]').forEach(el =>
    el.onclick = () => onPick(el.dataset.fcat));

  window.PodFeed = { lines, entries, render, folds, chips, bindChips, fmtT, fmtN, buff, KIND_ICON, ROLE_ICON, CLASS_ROLES, rolesOf };
})();
