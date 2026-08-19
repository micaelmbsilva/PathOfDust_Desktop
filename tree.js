// Shared passive-tree canvas. One renderer for every tree the app draws: your
// own (clickable), your Split Personality 2nd class (clickable, same point
// pool), and another player's (read-only). The bridge normalises all three into
// the same { stage, nodes, connectors } shape, so the only difference here is
// whether the rank pips do anything.
//
// Visual language ported 1:1 from the live site's passives page (its own
// .ptree-page rules): red #ff3b4e invested dots, gold #ffd76b spec point,
// pill chips, per-state name colors. Layout stays ours.
(function () {
  const NODE_H = 84;   // compact, a touch taller than the live node
  // Fit the tree to whatever we're actually inside — a pop-out window or a
  // resizable panel's iframe — measured per render, not once at load.
  const targetW = () => Math.min(1780, Math.max(560, (document.documentElement.clientWidth || screen.availWidth) - 40));

  const CSS = `
  /* The stage element becomes the SCROLLER and the tree canvas moves inside it,
     so zooming past the fit width scrolls the tree instead of the whole page —
     the points chip, Memories card and 2nd-class picker stay where they are. */
  .pod-tree-wrap { overflow: auto; max-width: 100%; }
  .pod-tree-zoom { position: relative; margin: 0 auto; }
  .pod-tree { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  /* left/top only — NOT inset:0, which would stretch the SVG to the whole
     stage and break the connector-to-node alignment. Its width/height are set
     in JS to match the node coordinate scale exactly. */
  .pod-tree svg.connectors { position: absolute; left: 0; top: 0; pointer-events: none; shape-rendering: crispEdges; }
  .pod-tree .node { position: absolute; background: #1c1830; border: 1.5px solid rgba(160,140,255,0.18);
    border-radius: 10px; padding: 6px 8px; text-align: center;
    display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .pod-tree .node .nm { font-weight: 700; font-size: 0.78rem; line-height: 1.2; color: #eae6f5; }
  .pod-tree .node .tr { font-size: 0.56rem; letter-spacing: 0.06em; text-transform: uppercase; color: #766a99; }
  .pod-tree .node.maxed { border-color: rgba(255,59,78,0.55);
    box-shadow: 0 0 0 1px rgba(255,59,78,0.12), 0 8px 22px rgba(255,59,78,0.12); }
  .pod-tree .node.maxed .nm { color: #ff8a8a; }
  .pod-tree .node.specialized { border-color: rgba(255,215,107,0.6);
    box-shadow: 0 0 0 1px rgba(255,215,107,0.15), 0 8px 22px rgba(255,215,107,0.12); }
  .pod-tree .node.specialized .nm { color: #ffd76b; }
  .pod-tree .node.invested { border-color: rgba(160,140,255,0.45); }
  .pod-tree .node.locked { opacity: 0.45; }
  .pod-tree .node.locked .nm { color: #a394c7; }
  .pod-tree .node.inactive { border-style: dashed; filter: grayscale(0.4); opacity: 0.7; } /* not implemented in-game */
  .pod-tree .node.root { background: linear-gradient(160deg, rgba(255,59,78,0.16), rgba(28,24,48,0.9));
    border-color: rgba(255,59,78,0.5); }
  .pod-tree .node.root .nm { font-size: 0.92rem; letter-spacing: 0.04em; }
  .pod-tree .node.root .acts .tr { text-transform: none; letter-spacing: 0; font-size: 0.7rem; color: #a394c7; }
  .pod-tree .node .acts { display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: auto; }
  /* rank dots, exactly the live page's: red filled + glow, gold spec point */
  .pod-tree .pip { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid #766a99; }
  .pod-tree.live .pip { cursor: pointer; }
  .pod-tree.live .pip:hover { border-color: #ff3b4e; }
  .pod-tree .pip.on { background: #ff3b4e; border-color: #ff3b4e; box-shadow: 0 0 6px rgba(255,59,78,0.7); }
  .pod-tree.live .pip.gold:hover { border-color: #ffd76b; }
  .pod-tree .pip.gold.on { background: #ffd76b; border-color: #ffd76b; box-shadow: 0 0 6px rgba(255,215,107,0.7); }
  .pod-tree .node.locked .pip { pointer-events: none; } /* needs a point in the node above first */

  .pod-legend { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin: 4px 0 12px;
    padding: 8px 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(160,140,255,0.18);
    border-radius: 10px; font-size: 0.72rem; color: #a394c7; }
  .pod-legend .li { display: flex; align-items: center; gap: 6px; }
  .pod-legend .ld { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid #766a99; display: inline-block; }
  .pod-legend .ld.on { background: #ff3b4e; border-color: #ff3b4e; }
  .pod-legend .ld.spec { background: #ffd76b; border-color: #ffd76b; }

  .pod-zoom { display: inline-flex; align-items: center; gap: 2px; background: rgba(255,255,255,0.04);
    border: 1px solid rgba(160,140,255,0.18); border-radius: 999px; padding: 2px 4px; }
  .pod-zoom button { font: inherit; font-size: 0.8rem; line-height: 1; color: #a394c7; background: none;
    border: 0; border-radius: 999px; padding: 4px 8px; cursor: pointer; }
  .pod-zoom button:hover:not(:disabled) { background: rgba(160,140,255,0.15); color: #eae6f5; }
  .pod-zoom button:disabled { opacity: 0.35; cursor: default; }
  .pod-zoom .lvl { min-width: 42px; font-size: 0.72rem; color: #a394c7; font-variant-numeric: tabular-nums; }`;

  if (!document.getElementById('pod-tree-css')) {
    const s = document.createElement('style');
    s.id = 'pod-tree-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // Orthogonal bracket connectors, drawn in scaled px so they always meet cards.
  // Each child (next row down) attaches to its nearest node in the row above.
  // Real parent→child topology from the site's own connector SVG (per bus:
  // the up-stub picks the parent, the down-stubs pick the children — nearest
  // node by centre-x, which survives the site's fixed coordinate offset). Works
  // for any archetype; falls back to nearest-row-x if no SVG edges are found.
  function deriveEdges(nodes, connectors) {
    const rowYs = [...new Set(nodes.map(n => n.y))].sort((a, b) => a - b);
    const cxN = (n) => n.x + n.w / 2;
    const nearest = (x, cand) => cand.reduce((a, b) => Math.abs(cxN(b) - x) < Math.abs(cxN(a) - x) ? b : a);
    const lines = [...(connectors || '').matchAll(/x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"(?:\s+stroke="([^"]+)")?/g)]
      .map(m => ({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], stroke: m[5] || null }));
    const horiz = lines.filter(l => Math.abs(l.y1 - l.y2) < 0.5);
    const vert = lines.filter(l => Math.abs(l.x1 - l.x2) < 0.5);
    const kids = new Map(), seen = new Set();
    for (const bus of horiz) {
      const B = bus.y1, xL = Math.min(bus.x1, bus.x2) - 1, xR = Math.max(bus.x1, bus.x2) + 1;
      const above = rowYs.filter(y => y < B), below = rowYs.filter(y => y > B);
      if (!above.length || !below.length) continue;
      const parents = nodes.filter(n => n.y === Math.max(...above));
      const children = nodes.filter(n => n.y === Math.min(...below));
      const inR = (v) => v.x1 >= xL && v.x1 <= xR;
      const ups = vert.filter(v => inR(v) && Math.min(v.y1, v.y2) < B - 0.5);
      const downs = vert.filter(v => inR(v) && Math.max(v.y1, v.y2) > B + 0.5);
      if (!ups.length || !downs.length) continue;
      const parent = nearest(ups[0].x1, parents);
      for (const d of downs) {
        const child = nearest(d.x1, children);
        // Read-only pages carry no node_key, so identity falls back to the name.
        const k = (parent.key || parent.name) + '>' + (child.key || child.name);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!kids.has(parent)) kids.set(parent, { busColor: bus.stroke, kids: [] });
        kids.get(parent).kids.push({ c: child, color: d.stroke }); // keep the site's per-stub color (red = inactive route)
      }
    }
    if (kids.size) return kids;
    // fallback: nearest-x per consecutive row
    for (let r = 0; r < rowYs.length - 1; r++) {
      const parents = nodes.filter(n => n.y === rowYs[r]);
      const children = nodes.filter(n => n.y === rowYs[r + 1]);
      for (const c of children) {
        const p = parents.reduce((a, b) => Math.abs(cxN(b) - cxN(c)) < Math.abs(cxN(a) - cxN(c)) ? b : a);
        if (!kids.has(p)) kids.set(p, { busColor: null, kids: [] });
        kids.get(p).kids.push({ c, color: null });
      }
    }
    return kids;
  }

  function connectorsSVG(nodes, S, offY, SW, SH, connectors) {
    const cx = (n) => (n.x + n.w / 2) * S, top = (n) => (n.y - offY) * S, bot = (n) => top(n) + NODE_H;
    const L = (x1, y1, x2, y2, col) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col || '#7a6ba8'}" stroke-width="2"/>`;
    let out = '';
    for (const [p, { busColor, kids }] of deriveEdges(nodes, connectors)) {
      const ns = kids.map(k => k.c);
      const busY = (bot(p) + Math.min(...ns.map(top))) / 2;
      out += L(cx(p), bot(p), cx(p), busY, busColor);
      out += L(Math.min(...ns.map(cx)), busY, Math.max(...ns.map(cx)), busY, busColor);
      for (const k of kids) out += L(cx(k.c), busY, cx(k.c), top(k.c), k.color); // per-stub site color
    }
    return `<svg class="connectors" width="${SW}" height="${SH}">${out}</svg>`;
  }

  // Rank circles from "cur/max" — the 4th pip on a Specialization is the gold
  // specialize point (reveals its modifiers), mirroring the live site.
  function pips(n, i0) {
    const m = (n.rank || '').match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return `<span class="tr">${esc(n.rank || '')}</span>`;
    const cur = +m[1], max = +m[2];
    let out = '';
    for (let i = 1; i <= max; i++) {
      const gold = n.cls.includes('node-spec') && i === max;
      out += `<span class="pip ${i <= cur ? 'on' : ''} ${gold ? 'gold' : ''}" data-n="${i0}" data-i="${i}" data-cur="${cur}" title="${i}/${max}"></span>`;
    }
    return out;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Zoom, applied on TOP of the fit-to-width scale and to the tree canvas only —
  // never the page — so the points chip, Memories card and 2nd-class picker
  // don't move. Kept here rather than per-page because both trees on /passives
  // (primary and Split Personality's) have to zoom together, and the character
  // sheet draws the same two. Persisted: a player who shrinks a big tree once
  // means it, and re-picking the zoom after every refresh() would be the whole
  // annoyance again.
  const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5, ZOOM_STEP = 0.15;
  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  let Z = clampZoom(+localStorage.getItem('podTreeZoom') || 1);
  // Every stage we've drawn, so a zoom change can redraw them all without the
  // page handing the data back. Same elements every time (#stage / #secStage).
  const drawn = new Map();

  function setZoom(z) {
    const next = clampZoom(z);
    if (next === Z) return;
    Z = next;
    try { localStorage.setItem('podTreeZoom', String(Z)); } catch {} // private mode
    for (const [el, r] of drawn) draw(el, r.tree, r.opts);
    // Live DOM query rather than a registry of mounted bars: the pages rebuild
    // their bars on every load, and a registry would just accumulate detached ones.
    document.querySelectorAll('.pod-zoom').forEach(syncZoomBar);
  }

  function syncZoomBar(bar) {
    bar.querySelector('.lvl').textContent = Math.round(Z * 100) + '%';
    bar.querySelector('[data-z="out"]').disabled = Z <= ZOOM_MIN;
    bar.querySelector('[data-z="in"]').disabled = Z >= ZOOM_MAX;
  }

  // Drop a zoom control into a page's own bar. The pages rebuild those bars on
  // every load, so this runs again each time and just re-renders at the
  // current level - there's no state here to lose.
  function mountZoom(bar) {
    bar.classList.add('pod-zoom');
    bar.innerHTML = '<button type="button" data-z="out" title="Zoom out">&minus;</button>' +
      '<button type="button" class="lvl" data-z="fit" title="Reset to fit"></button>' +
      '<button type="button" data-z="in" title="Zoom in">+</button>';
    bar.querySelector('[data-z="out"]').onclick = () => setZoom(Z - ZOOM_STEP);
    bar.querySelector('[data-z="in"]').onclick = () => setZoom(Z + ZOOM_STEP);
    bar.querySelector('[data-z="fit"]').onclick = () => setZoom(1);
    syncZoomBar(bar);
    return bar;
  }

  // tree: { stage:{w,h}, nodes, connectors } straight off the bridge.
  // opts.onAllocate(node, delta) -> Promise<boolean keepGoing>; omit for read-only.
  // Remembered so setZoom can redraw without the caller re-fetching.
  function render(el, tree, opts) {
    drawn.set(el, { tree, opts: opts || {} });
    draw(el, tree, opts || {});
  }

  function draw(el, tree, opts) {
    const nodes = tree.nodes || [];
    // `el` is the SCROLLER; the canvas is an inner div sized in real pixels, so
    // a zoomed-in tree scrolls inside its own box instead of stretching the page.
    el.classList.add('pod-tree-wrap');
    // Ctrl/Cmd+wheel is the gesture people reach for first. Bound to the
    // scroller once (innerHTML replacement below doesn't clear listeners on the
    // element itself, so re-binding every draw would stack them), and
    // preventDefault matters: without it the Electron shell zooms the whole UI.
    if (!el.dataset.zoomWired) {
      el.dataset.zoomWired = '1';
      el.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom(Z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      }, { passive: false });
    }
    if (!nodes.length) { el.innerHTML = ''; el.style.height = '0px'; return; }

    const offY = Math.max(0, Math.min(...nodes.map(n => n.y)) - 30); // trim empty top band
    // Scale to fit the whole tree in TARGET_W. Some nodes overhang the native
    // SVG width, so size the canvas off the real content extent, but keep the
    // SVG's own scale = S (viewBox stays native) so lines stay aligned to nodes.
    const contentW = Math.max(tree.stage.w, ...nodes.map(n => n.x + n.w));
    const maxY = Math.max(...nodes.map(n => n.y));
    const S = Math.min(1.6, Math.max(1.05, targetW() / contentW));
    const SW = contentW * S;
    const SH = Math.max((tree.stage.h - offY) * S, (maxY - offY) * S + NODE_H + 14);
    // Zoom is a CSS transform on the finished canvas, NOT another factor in S.
    // S only scales x/width — node height and every font size are fixed px — so
    // folding zoom into it would stretch the cards sideways instead of zooming.
    // The spacer carries the scaled box so the scroller still sees the overflow
    // (a transform doesn't affect layout size).
    const ZW = SW * Z, ZH = SH * Z;
    // Keep whatever the player was looking at centred across a zoom or a
    // post-action redraw — innerHTML resets scroll, and a big tree that jumps
    // back to the top-left after every click is the thing zoom is here to fix.
    const cx = (el.scrollLeft + el.clientWidth / 2) * (ZW / (+el.dataset.canvasW || ZW)) - el.clientWidth / 2;
    const cy = (el.scrollTop + el.clientHeight / 2) * (ZH / (+el.dataset.canvasH || ZH)) - el.clientHeight / 2;
    el.dataset.canvasW = ZW; el.dataset.canvasH = ZH;
    el.style.height = '';
    // Draw our own connectors from the real node positions — the site's SVG
    // stops short of the cards by non-constant offsets, so it can't be reused.
    el.innerHTML = `<div class="pod-tree-zoom" style="width:${ZW}px;height:${ZH}px;">` +
      `<div class="pod-tree${opts.onAllocate ? ' live' : ''}" style="width:${SW}px;height:${SH}px;transform:scale(${Z});">` +
      connectorsSVG(nodes, S, offY, SW, SH, tree.connectors) + nodes.map((n, i) => {
      const specialized = n.cls.includes('specialized');                        // gold: took the 4th point
      const maxed = !specialized && n.cls.includes('maxed');                    // red: full ranks
      const locked = n.cls.includes('locked');
      const invested = n.cls.includes('invested');                              // partially ranked
      const inactive = /inactive/.test(n.cls) || /\(inactive\)/i.test(n.name);  // not implemented in-game yet
      const root = n.cls.includes('node-root');                                 // class passive — always active
      const kind = root || n.cls.includes('node-skill') ? (n.tier || '') : '';  // site hides the label on spec/mod
      return `<div class="node ${maxed ? 'maxed' : ''} ${specialized ? 'specialized' : ''} ${locked ? 'locked' : ''} ${invested ? 'invested' : ''} ${inactive ? 'inactive' : ''} ${root ? 'root' : ''}"
        style="left:${n.x * S}px;top:${(n.y - offY) * S}px;width:${n.w * S}px;height:${NODE_H}px;"
        data-tip="${esc(n.desc)}${n.tuned ? ` — ⚙ ${esc(n.tuned)} (retuned live; the description above is stale)` : ''}">
        <div class="nm">${esc(n.name)}${n.tuned ? ' ⚙' : ''}</div>
        ${kind ? `<div class="tr">${esc(kind)}</div>` : ''}
        <div class="acts">${root ? `<span class="tr">${esc(n.desc)}</span>` : pips(n, i)}</div>
      </div>`;
    }).join('') + '</div></div>';
    el.scrollLeft = Math.max(0, cx); el.scrollTop = Math.max(0, cy);

    if (!opts.onAllocate) return;
    // Click a pip to jump to that rank (clicking the current top pip steps down
    // one). Inactive nodes stay allocatable — points persist and take effect if
    // the game implements them; only locked nodes (need parent point) don't.
    el.querySelectorAll('.pip').forEach(pip => pip.onclick = async () => {
      const n = nodes[+pip.dataset.n];
      const cur = +pip.dataset.cur;
      let target = +pip.dataset.i;
      if (target === cur) target = cur - 1;
      const step = target > cur ? 1 : -1;
      for (let r = cur; r !== target; r += step) {
        if (!await opts.onAllocate(n, step)) break; // out of points / rejected — stop, refresh shows truth
      }
      if (opts.onDone) opts.onDone(); // one reload after the whole walk, not per step
    });
  }

  const LEGEND = `<div class="pod-legend">
    <span class="li"><span class="ld on"></span><span class="ld on"></span><span class="ld on"></span> Maxed</span>
    <span class="li"><span class="ld on"></span><span class="ld"></span><span class="ld"></span> Partially invested</span>
    <span class="li"><span class="ld"></span><span class="ld"></span><span class="ld"></span> Not invested</span>
    <span class="li"><span class="ld on"></span><span class="ld on"></span><span class="ld on"></span><span class="ld spec"></span> 4th (gold) point — specializes</span>
    <span class="li">Greyed — needs a point in the node above</span>
    <span class="li">Dashed — not implemented yet (points still bank)</span>
  </div>`;

  window.PodTree = { render, mountZoom, legend: LEGEND };
})();
