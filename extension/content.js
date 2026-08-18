// Twitch chat content script: tag "#pod-item=" links as they appear, show a
// PoE-style hover card (rendered by card.js, styled by tooltip.css). Hover
// only — clicks still navigate to the game site like any link.
(async () => {
  const codec = await import(chrome.runtime.getURL('shared/item-codec.mjs'));
  const LINK_RE = codec.LINK_RE;

  // One shared floating card container, tooltip.js-style (position at cursor,
  // flip at viewport edges).
  const tt = document.createElement('div');
  tt.className = 'pod-tt';
  tt.style.display = 'none';
  document.body.appendChild(tt);

  const decoded = new Map(); // payload -> Promise<item|null>
  const decode = (payload) => {
    if (!decoded.has(payload)) decoded.set(payload, codec.decodeItem(payload).catch(() => null));
    return decoded.get(payload);
  };

  let cur = null;
  const show = async (link) => {
    cur = link;
    const item = await decode(link.dataset.podItem);
    if (cur !== link) return; // hovered away while decoding
    tt.replaceChildren(item ? window.podItemCard(item) : Object.assign(document.createElement('div'), { textContent: 'Unreadable item link' }));
    tt.style.display = 'block';
  };
  const hide = () => { tt.style.display = 'none'; cur = null; };

  document.addEventListener('mouseover', (e) => {
    const link = e.target.closest?.('[data-pod-item]');
    if (link) show(link);
  });
  document.addEventListener('mouseout', (e) => {
    if (cur && !cur.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('mousemove', (e) => {
    if (tt.style.display === 'none') return;
    let x = e.clientX + 14, y = e.clientY + 16;
    const r = tt.getBoundingClientRect();
    if (x + r.width > innerWidth) x = e.clientX - r.width - 10;
    if (y + r.height > innerHeight) y = e.clientY - r.height - 10;
    tt.style.left = x + 'px'; tt.style.top = y + 'px';
  });

  // Tag anchors whose href (or text — Twitch sometimes strips fragments from
  // the href but keeps the full URL as the link text) carries a payload.
  const tag = (root) => {
    for (const a of root.querySelectorAll('a[href]')) {
      if (a.dataset.podItem !== undefined) continue;
      const m = LINK_RE.exec(a.href) || LINK_RE.exec(a.textContent);
      if (m) { a.dataset.podItem = m[1]; a.classList.add('pod-item-link'); }
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
