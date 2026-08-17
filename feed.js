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
  .pod-feed .fl .mit { color: #8a7fb0; font-size: 0.92em; }`;
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
  // Events carry raw simulation time; the on-screen replay compresses it, so
  // display time would read 0:00 for everything. Show the sim tick instead.
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
  const BUFFS = {
    // yours
    speed_stacks: ['Attack Speed Stacks', 'buff', 'Momentum / Fleetfoot / Bloodlust / Relentless Pursuit / Flow State — the shared per-hit speed bundle'],
    flowing_stacks: ['Flowing Strikes', 'buff', "Monk — stacks as you keep hitting"],
    fel_rush_speed_bonus: ['Fel Rush', 'buff', 'Warlock — bonus attack speed'],
    blood_frenzy_speed_bonus: ['Blood Frenzy', 'buff', 'Slayer — bonus attack speed'],
    endless_thirst_cap_bonus: ['Endless Thirst', 'buff', 'Slayer — raised life-leech cap (1 = uncapped at rank 3)'],
    shield_hp: ['Shield', 'buff', 'Absorb pool from Overflowing Grace / Divine Favor / Martyrdom / Arcane Shield'],
    temp_heal_power_bonus: ['Healing Power', 'buff', 'Temporary bonus to healing you do'],
    temp_damage_reduction_bonus: ['Damage Reduction', 'buff', 'Temporary bonus damage reduction'],
    fire_dr_buff_stacks: ['Fire — Damage Reduction', 'buff', 'Elemental proc: bonus damage reduction'],
    cold_evasion_buff_stacks: ['Cold — Evasion', 'buff', 'Elemental proc: bonus evasion'],
    chaos_block_buff_stacks: ['Chaos — Block', 'buff', 'Elemental proc: bonus block'],
    divine_heal_power_buff_stacks: ['Divine — Healing Power', 'buff', 'Elemental proc: bonus healing power'],
    elemental_overflow_dmg_bonus: ['Elemental Overflow', 'buff', 'Bonus damage from overflowing elemental stacks'],
    // theirs
    wound_stacks: ['Open Wound', 'debuff', "Slayer's bleed stacking on you"],
    marked: ['Marked', 'debuff', 'Singled out on first hit — lasts the rest of the fight'],
    curse_dmg_taken_bonus: ['Curse of Weakness', 'debuff', 'You take extra damage — lasts the rest of the fight'],
    temp_damage_dealt_debuff: ['Damage Dealt Reduced', 'debuff', 'Your outgoing damage is cut'],
    temp_evasion_debuff: ['Evasion Reduced', 'debuff', 'You dodge less'],
    lingering_dot_count: ['Damage Over Time', 'debuff', 'Independent damage-over-time effects ticking on you'],
    fire_dr_debuff_stacks: ['Fire — DR Lowered', 'debuff', 'Elemental proc: your damage reduction is cut'],
    cold_evasion_debuff_stacks: ['Cold — Evasion Lowered', 'debuff', 'Elemental proc: your evasion is cut'],
    chaos_block_debuff_stacks: ['Chaos — Block Lowered', 'debuff', 'Elemental proc: your block is cut'],
    lightning_dmg_taken_stacks: ['Lightning — Damage Taken', 'debuff', 'Elemental proc: you take extra damage'],
    divine_heal_reduction_stacks: ['Divine — Healing Cut', 'debuff', 'Elemental proc: healing on you is reduced'],
    // pools and counters
    bloodpact_uses_this_fight: ['Bloodpact Used', 'charge', 'Times Bloodpact has fired this fight'],
    guardian_spirit_charges_remaining: ['Guardian Spirit', 'charge', 'Charges left'],
    assassinate_charges_remaining: ['Assassinate', 'charge', 'Charges left'],
    undying_will_charges_remaining: ['Undying Will', 'charge', 'Charges left'],
  };
  const prettyKey = (k) => String(k).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  // Unknown keys degrade to a readable name and no claim about which they are:
  // a new mechanic must not be labelled a buff just because we haven't met it.
  const buff = (k) => { const b = BUFFS[k]; return b ? { key: k, label: b[0], kind: b[1], desc: b[2] }
    : { key: k, label: prettyKey(k), kind: 'unknown', desc: '' }; };
  const KIND_ICON = { buff: '🟢', debuff: '🔴', charge: '🔵', unknown: '⚪' };

  const CATS = { dmg: ['hit', 'taken', 'myevaded', 'dodged', 'death'],
    heals: ['healed', 'healout', 'shielded', 'shieldout'], buffs: ['buffgain', 'bufflost'] };
  const CHIPS = [['all', 'All'], ['dmg', '⚔️ Damage'], ['heals', '💚 Heals'], ['buffs', '✨ Buffs']];
  const passes = (g, cat) => !cat || cat === 'all' || (CATS[cat] || []).includes(g.kind);

  const chips = (cat) => `<div class="rolechips fchips">` + CHIPS.map(([v, l]) =>
    `<span class="chip pf${(cat || 'all') === v ? ' on' : ''}" data-fcat="${v}">${esc(l)}</span>`).join('') + '</div>';

  // filter -> collapse identical consecutive lines -> render
  function lines(groups, cat) {
    const out = [];
    for (const g of groups || []) {
      if (!passes(g, cat) || !FLINE[g.kind]) continue;
      const txt = FLINE[g.kind](g);
      const prev = out[out.length - 1];
      // Collapse only near-adjacent repeats (<=2s apart) — a repeat minutes
      // later is its own event and keeps its own timestamp.
      if (prev && prev.txt === txt && (g.at || 0) - (prev.lastAt || 0) <= 2000) { prev.n++; prev.lastAt = g.at; continue; }
      out.push({ at: g.at, lastAt: g.at, kind: g.kind, txt, n: 1 });
    }
    return out.map(l => `<div class="fl ${l.kind}"><span class="ft">${fmtT(l.at)}</span>${l.txt}${l.n > 1 ? ` <b>×${l.n}</b>` : ''}</div>`).join('');
  }

  const bindChips = (root, onPick) => root.querySelectorAll('[data-fcat]').forEach(el =>
    el.onclick = () => onPick(el.dataset.fcat));

  window.PodFeed = { lines, chips, bindChips, fmtT, fmtN, buff, KIND_ICON };
})();
