// Shared styled tooltip, like the live site's [data-tip] hovers. Any element
// with a data-tip attribute shows an immediate floating box on hover.
(function () {
  const tip = document.createElement('div');
  tip.style.cssText = [
    'position:fixed', 'z-index:99999', 'pointer-events:none', 'max-width:300px',
    'background:rgba(20,16,32,0.98)', 'border:1px solid rgba(160,140,255,0.45)',
    'color:#eae6f5', 'font:12px/1.45 "Segoe UI",Arial,sans-serif',
    'padding:7px 10px', 'border-radius:8px', 'box-shadow:0 8px 24px #000a', 'display:none',
  ].join(';');
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip));
  if (document.body) document.body.appendChild(tip);

  let cur = null;
  const show = (el) => {
    const t = el.getAttribute('data-tip');
    if (!t) return;
    tip.textContent = t; tip.style.display = 'block'; cur = el;
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
    if (tip.style.display === 'none') return;
    let x = e.clientX + 14, y = e.clientY + 16;
    const r = tip.getBoundingClientRect();
    if (x + r.width > innerWidth) x = e.clientX - r.width - 10;
    if (y + r.height > innerHeight) y = e.clientY - r.height - 10;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
})();
