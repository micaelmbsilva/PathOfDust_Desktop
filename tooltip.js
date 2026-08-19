// Shared styled tooltip, like the live site's [data-tip] hovers. Any element
// with a data-tip attribute shows an immediate floating box on hover.
(function () {
  const tip = document.createElement('div');
  tip.style.cssText = [
    'position:fixed', 'z-index:99999', 'pointer-events:none', 'max-width:300px',
    'background:rgba(20,16,32,0.98)', 'border:1px solid rgba(160,140,255,0.45)',
    'color:#eae6f5', 'font:12px/1.45 "Segoe UI",Arial,sans-serif',
    'padding:7px 10px', 'border-radius:8px', 'box-shadow:0 8px 24px #000a', 'display:none',
    // Lets a data-tip carry paragraphs — the buff hovers use them for
    // "what it does" / "where it comes from" / the raw key.
    'white-space:pre-line',
  ].join(';');
  document.body.appendChild(tip); // this script is loaded at end of <body>, so body exists

  let cur = null;
  // The box only changes size when its text does, i.e. in show(). Measuring
  // there instead of on every mousemove takes a forced synchronous layout out
  // of the pointer path — it was reading getBoundingClientRect one event after
  // writing left/top, which is the classic read-after-write reflow, on a page
  // whose bag grid can be thousands of elements.
  let tw = 0, th = 0;
  const show = (el) => {
    const t = el.getAttribute('data-tip');
    if (!t) return;
    tip.textContent = t; tip.style.display = 'block'; cur = el;
    const r = tip.getBoundingClientRect(); tw = r.width; th = r.height;
  };
  const hide = () => { tip.style.display = 'none'; cur = null; };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) show(el);
  });
  document.addEventListener('mouseout', (e) => {
    if (cur && !cur.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('mousemove', (e) => {
    if (!cur) return;
    let x = e.clientX + 14, y = e.clientY + 16;
    if (x + tw > innerWidth) x = e.clientX - tw - 10;
    if (y + th > innerHeight) y = e.clientY - th - 10;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
})();
