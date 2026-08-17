// Keeps whatever page includes it current with the bridge's interface revision.
//
// A hot-pull rewrites the files on disk, but every window already open keeps
// running the copy it loaded. The main window used to reload only itself, so
// Bag, Passives, Characters and Fight History — separate documents, whether
// popped out or in a panel iframe — went on running last week's code until
// somebody happened to reopen them. Each document now watches for itself,
// which is why this is a shared script rather than logic in index.html.
//
// It only ever asks the LOCAL bridge (see pullInterface in server.mjs for why
// nothing here talks to GitHub), and only reacts to the interface revision.
// A changed bridge revision needs a full app restart, which reloading can't
// achieve — index.html raises its own banner for that.
(function () {
  const POLL_MS = 60000;
  const IDLE_MS = 15000;   // don't yank the page out from under an active user
  let known = null;
  let reloading = false;

  // No-store is set on everything the bridge serves, so a plain reload refetches
  // rather than replaying the copy this document already parsed. Guarded because
  // a navigation isn't instant — the next poll must not fire a second one.
  const reload = () => { if (!reloading) { reloading = true; location.reload(); } };

  let lastInput = Date.now();
  for (const ev of ['pointerdown', 'keydown', 'wheel']) {
    addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true });
  }
  // Hidden pages (a collapsed panel, a background window) can go immediately.
  const idle = () => document.hidden || Date.now() - lastInput > IDLE_MS;

  async function check() {
    let v;
    try { v = await fetch('/api/version', { cache: 'no-store' }).then(r => r.json()); }
    catch { return; } // bridge restarting or gone — try again next tick
    if (!v || typeof v.ui !== 'number') return; // bridge too old to report it
    if (known === null) { known = v.ui; return; }
    if (v.ui === known) return;
    if (idle()) return reload();
    setTimeout(check, 5000); // busy right now — ask again shortly
  }

  check();
  setInterval(check, POLL_MS);
  // A window coming back to the foreground is the cheapest moment to catch up.
  addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
})();
