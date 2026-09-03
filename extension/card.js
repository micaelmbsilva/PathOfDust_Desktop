// PoE-style item card for decoded pod-item payloads (shape: see
// shared/item-codec.mjs). Ported from lokati_overlay bag.html itemCard/modLine
// — same T1-T8 roll thresholds and palette, DOM built with textContent only so
// chat-supplied strings can never inject markup.
(function () {
  const SLOT_EMOJI = { weapon: '⚔️', helm: '🪖', body: '🛡️', gloves: '🧤', boots: '🥾', ring1: '💍', ring2: '💍', amulet: '📿', pants: '👖' };
  // Payloads carry the canonical key (ring1), but an old link or a hand-made
  // one may carry the site's display text — normalise the same way bag.html does.
  const SLOT_LABEL = { ring1: 'Ring I', ring2: 'Ring II' };
  const slotKey = (s) => { const k = (s || '').toLowerCase().trim(); return k === 'ring i' ? 'ring1' : k === 'ring ii' ? 'ring2' : k.replace(/\s+/g, ''); };
  // Roll % → tier (T1 best): T1 95-100, T2 90-94, T3 75-89, T4 50-74,
  // T5 35-49, T6 25-34, T7 15-24, T8 0-14. Gold when roll > 90.
  const tierOf = (r) => r >= 95 ? 1 : r >= 90 ? 2 : r >= 75 ? 3 : r >= 50 ? 4 : r >= 35 ? 5 : r >= 25 ? 6 : r >= 15 ? 7 : 8;
  const el = (tag, cls, text) => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  };
  const title = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1).toLowerCase();

  window.podItemCard = function (it) {
    const f = it.f || {};
    const card = el('div', 'pod-tt-card');
    card.appendChild(el('div', 'pod-tt-name' + (f.kr ? ' kr' : f.sa ? ' sa' : f.un ? ' un' : ''), it.n || 'Unknown item'));
    const slot = slotKey(it.s);
    const sub = [
      slot ? `${SLOT_EMOJI[slot] || ''} ${SLOT_LABEL[slot] || title(slot)}`.trim() : '',
      it.t ? 'T' + it.t : '',
      it.q || '',
      it.p || '',
    ].filter(Boolean).join(' · ');
    if (sub) card.appendChild(el('div', 'pod-tt-sub', sub));
    for (const imp of it.im || []) card.appendChild(el('div', 'pod-tt-imp', imp));
    const mods = el('div', 'pod-tt-mods');
    for (const [text, roll, crit] of it.m || []) {
      const row = el('div', 'pod-tt-mod');
      row.appendChild(el('span', crit ? 'crit' : '', text));
      if (roll != null) {
        const t = tierOf(roll);
        row.appendChild(el('span', `pod-tt-roll t${t}${roll > 90 ? ' gold' : ''}`, `T${t} · ${roll}%`));
      }
      mods.appendChild(row);
    }
    if (mods.childNodes.length) card.appendChild(mods);
    return card;
  };
})();
