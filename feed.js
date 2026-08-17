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
  const prettyBuff = (k) => String(k).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const buffNames = (g) => (g.names || []).map(k => esc(prettyBuff(k))).join(', ');
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
    bufflost: (g) => `🕯️ Faded: ${buffNames(g)}`,
    death: () => `💀 You were defeated`,
  };

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

  window.PodFeed = { lines, chips, bindChips, fmtT, fmtN };
})();
