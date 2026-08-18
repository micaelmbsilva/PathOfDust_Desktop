// Twitch chat content script: tag "#pod-item=" links as they appear, replace
// their visible URL with the item's name (PoE-style), and show the full card
// on hover (rendered by card.js, styled by tooltip.css). Runs in every frame
// (all_frames — the desktop app hosts chat in an iframe). Clicks still
// navigate to the game site like any link. Codec comes from
// shared/item-codec.js, loaded before this file by the manifest.
(() => {
  const { decodeItem, LINK_RE } = globalThis.PodItemCodec;

  // One shared floating card container, tooltip.js-style (position at cursor,
  // flip at viewport edges).
  const tt = document.createElement('div');
  tt.className = 'pod-tt';
  tt.style.display = 'none';
  document.body.appendChild(tt);

  const decoded = new Map(); // payload -> Promise<item|null>
  const decode = (payload) => {
    if (!decoded.has(payload)) decoded.set(payload, decodeItem(payload).catch(() => null));
    return decoded.get(payload);
  };

  let cur = null, mx = 0, my = 0;
  // Place at the last pointer (or focused link) position, flipping at edges.
  const place = () => {
    const r = tt.getBoundingClientRect();
    let x = mx + 14, y = my + 16;
    if (x + r.width > innerWidth) x = mx - r.width - 10;
    if (y + r.height > innerHeight) y = my - r.height - 10;
    tt.style.left = Math.max(4, x) + 'px';
    tt.style.top = Math.max(4, y) + 'px';
  };
  const show = async (link) => {
    if (cur === link) return; // mouseover bubbles from children
    cur = link;
    const item = await decode(link.dataset.podItem);
    if (cur !== link) return; // hovered away while decoding
    tt.replaceChildren(item ? window.podItemCard(item) : Object.assign(document.createElement('div'), { textContent: 'Unreadable item link' }));
    tt.style.display = 'block';
    place();
  };
  const hide = () => { tt.style.display = 'none'; cur = null; };

  document.addEventListener('mouseover', (e) => {
    const link = e.target.closest?.('[data-pod-item]');
    if (link) { mx = e.clientX; my = e.clientY; show(link); }
  });
  document.addEventListener('mouseout', (e) => {
    if (cur && !cur.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('mousemove', (e) => {
    mx = e.clientX; my = e.clientY;
    if (tt.style.display === 'none') return;
    // Chat prunes old messages: a hovered link can vanish without a mouseout.
    if (!cur?.isConnected) return hide();
    place();
  });
  // Keyboard users: links are focusable, so anchor the card to the link itself.
  document.addEventListener('focusin', (e) => {
    const link = e.target.closest?.('[data-pod-item]');
    if (!link) return;
    const r = link.getBoundingClientRect();
    mx = r.left - 14; my = r.bottom - 16;
    show(link);
  });
  document.addEventListener('focusout', () => { if (cur) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  // Tag anchors whose href (or text — Twitch sometimes strips fragments from
  // the href but keeps the full URL as the link text) carries a payload, then
  // swap the ugly URL for the item's name, PoE-style. Decode failure leaves
  // the raw URL visible so the message is never blanked.
  const tag = (root) => {
    for (const a of root.querySelectorAll('a[href]')) {
      if (a.dataset.podItem !== undefined) continue;
      const m = LINK_RE.exec(a.href) || LINK_RE.exec(a.textContent);
      if (!m) continue;
      a.dataset.podItem = m[1];
      a.classList.add('pod-item-link');
      decode(m[1]).then((item) => {
        if (!item || !item.n) return;
        const f = item.f || {};
        a.textContent = `[${item.n}]`;
        a.classList.add('pod-named', f.kr ? 'kr' : f.sa ? 'sa' : f.un ? 'un' : 'norm');
      });
    }
  };

  tag(document.body);
  // ponytail: body-wide observer, filtered to element nodes — scoping to the
  // chat container would need per-page-type selectors for no measured gain.
  new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const n of mu.addedNodes) if (n.nodeType === 1) tag(n);
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
