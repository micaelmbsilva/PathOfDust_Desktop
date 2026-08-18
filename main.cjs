// Electron shell: starts the bridge in-process and shows it in a real app
// window. Standalone .exe (bundled Chromium). Multi-user: no tokens are shipped —
// each user logs in once via the site's Twitch OAuth, and that one login drives
// everything (site session for stats/bag/passives/actions, and Twitch chat).
const { app, BrowserWindow, session, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Keep third-party cookies working in the embedded Twitch chat (so it's logged
// in and you can actually send messages), and let us iframe the full popout chat.
app.commandLine.appendSwitch('disable-features', 'ThirdPartyStoragePartitioning,PartitionedCookies');

const PORT = 8787;
const SITE = 'https://adventure.lokati.net';
const SEVENTV_ID = 'lppmekppnliemjclknbagdhoocikieoi';
const REPO = 'micaelmbsilva/PathOfDust_Desktop';

// Self-update: the app's web/bridge files (server.mjs, actions.mjs, *.html,
// tooltip.js) are plain text served from disk, so we refresh just those from
// the repo without reinstalling the Electron shell. Pinned to the latest commit
// SHA — raw.githubusercontent caches the branch path for ~5 min and ignores
// query cache-busters, but per-SHA paths are immutable, so the manifest and the
// files it lists always come from the same, current commit. Downloads a newer
// set into userData/app and returns the dir to load from (bundled otherwise).
// The Electron shell (main.cjs/Chromium) still needs a full reinstall to change.
async function resolveAppDir() {
  const appDir = path.join(app.getPath('userData'), 'app');
  const readVer = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version || 0; } catch { return 0; } };
  const bundledVer = readVer(__dirname);
  let localVer = readVer(appDir);
  try {
    const get = async (u, json) => {
      const r = await fetch(u, { headers: { 'User-Agent': 'PathOfDust' } }); // GH API needs a UA
      if (!r.ok) throw new Error(r.status);
      return json ? r.json() : r.text();
    };
    const sha = (await get(`https://api.github.com/repos/${REPO}/commits/main`, true)).sha;
    const base = `https://raw.githubusercontent.com/${REPO}/${sha}`; // immutable, never stale
    const manifest = JSON.parse(await get(`${base}/version.json`));
    // Reject a manifest whose filenames could escape appDir (../, absolute,
    // drive letter). The manifest is attacker-controlled if `main` is ever
    // compromised, and `f` goes straight into the write path. Mirrors safeFile
    // in server.mjs (main.cjs is CommonJS and can't import the ESM bridge).
    const safeFile = (f) => typeof f === 'string' && f.length > 0 && f.length < 200
      && !/[\\/]{2}|(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:|\0/.test(f) && !/[<>:"|?*]/.test(f);
    if (manifest.version > Math.max(bundledVer, localVer)
        && Array.isArray(manifest.files) && manifest.files.every(safeFile)) {
      const files = await Promise.all(manifest.files.map(f => get(`${base}/${f}`).then(t => [f, t])));
      fs.mkdirSync(appDir, { recursive: true });
      for (const [f, t] of files) { // all fetched before writing
        const p = path.join(appDir, f);
        fs.mkdirSync(path.dirname(p), { recursive: true }); // manifest may list subdir files (e.g. extension/)
        fs.writeFileSync(p, t);
      }
      fs.writeFileSync(path.join(appDir, 'version.json'), JSON.stringify(manifest));
      localVer = manifest.version;
    }
  } catch { /* offline / fetch failed — use what we already have */ }
  return localVer > bundledVer ? appDir : __dirname;
}

// Full-app self-update via electron-updater (NSIS + GitHub releases feed). The
// web/bridge files still hot-update in place via resolveAppDir; this handles the
// Electron shell itself, which those can't touch. Downloads in the background and
// prompts to restart once staged. Only meaningful in a packaged install.
function initAutoUpdate() {
  if (!app.isPackaged) return; // `electron .` dev runs have no update feed
  // Silent + relaunch: the installer is the assisted (directory-picking) one, so
  // the default would pop its full wizard on every auto-update. NSIS remembers
  // the directory the user chose, so a silent run still lands there.
  // macOS: Squirrel.Mac refuses to install into an app without a Developer ID
  // signature, so quitAndInstall on our ad-hoc-signed build silently no-ops.
  // Don't stage a download that can't apply; "apply" opens the release page
  // for a manual dmg instead. Real signing + notarization lifts this.
  const macManual = process.platform === 'darwin';
  global.__applyUpdate = macManual
    ? () => shell.openExternal('https://github.com/micaelmbsilva/PathOfDust_Desktop/releases/latest')
    : () => autoUpdater.quitAndInstall(true, true); // called by /api/apply-update
  global.__checkUpdate = () => autoUpdater.checkForUpdates().catch(() => {}); // called by /api/check-update
  autoUpdater.autoDownload = !macManual;
  // Publish update state on the global so the bridge can report it and the UI can
  // toast — "downloading" when found, "ready" once staged (mac: found = ready,
  // since "apply" is just a link there).
  autoUpdater.on('update-available', (i) => { global.__update = { status: macManual ? 'ready' : 'downloading', version: i.version }; });
  autoUpdater.on('update-downloaded', (i) => { global.__update = { status: 'ready', version: i.version }; });
  autoUpdater.on('error', () => {}); // offline / feed hiccup — retried by the interval below
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 15 * 60000); // keep long-running sessions current
}

// Load the 7TV extension (for custom emotes in the chat) from the user's own
// Chrome install if it's there. Its content script matches *.twitch.tv/*, so it
// injects into our chat iframe too. Silently skips if 7TV isn't installed.
async function load7tv() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome',
    'User Data', 'Default', 'Extensions', SEVENTV_ID);
  if (!fs.existsSync(base)) return;
  const ver = fs.readdirSync(base).filter(d => fs.existsSync(path.join(base, d, 'manifest.json'))).sort().pop();
  if (!ver) return;
  try { await session.defaultSession.loadExtension(path.join(base, ver), { allowFileAccess: true }); }
  catch { /* MV3 in Electron may reject it — no emotes, chat still works */ }
}

// Load the bundled Path of Dust item-link extension (extension/ — the embedded
// copy of pod_chat_extension) into the default session, same injection route
// as 7TV above: its content script matches *.twitch.tv/*, so hovering a
// "#pod-item=" share link in the chat panel shows the item card. Prefers the
// hot-updated copy when one exists.
async function loadItemLinks(dir) {
  const ext = [path.join(dir, 'extension'), path.join(__dirname, 'extension')]
    .find(p => fs.existsSync(path.join(p, 'manifest.json')));
  if (!ext) return;
  try { await session.defaultSession.loadExtension(ext); }
  catch (e) { console.warn('item-links extension failed to load:', e.message); } // chat still works, just without hover cards
}

// A random, anonymous per-install id (no name/PII), persisted in userData.
function installId() {
  const f = path.join(app.getPath('userData'), 'install-id');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const id = require('node:crypto').randomUUID();
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(f, id); } catch {}
  return id;
}

const getAdvSession = async () =>
  (await session.defaultSession.cookies.get({ url: SITE, name: 'adv_session' }))[0]?.value || null;

// Show the site login in-window and resolve once adv_session appears. The site
// bounces through id.twitch.tv OAuth; logging in there also logs Twitch in.
function runLogin(win) {
  return new Promise((resolve) => {
    const check = async () => { const v = await getAdvSession(); if (v) { cleanup(); resolve(v); } };
    const cleanup = () => {
      win.webContents.removeListener('did-navigate', check);
      win.webContents.removeListener('did-redirect-navigation', check);
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-redirect-navigation', check);
    win.loadURL(`${SITE}/login`);
  });
}

// Re-set every twitch.tv cookie with SameSite=None so the third-party chat
// iframe actually sends them (login cookies are usually Lax and would be dropped).
async function relaxTwitchCookies() {
  const cs = await session.defaultSession.cookies.get({ domain: '.twitch.tv' });
  for (const c of cs) {
    try {
      await session.defaultSession.cookies.set({
        url: `https://${c.domain.replace(/^\./, '')}`, name: c.name, value: c.value,
        domain: c.domain, path: c.path || '/', secure: true, httpOnly: c.httpOnly,
        sameSite: 'no_restriction', expirationDate: c.expirationDate,
      });
    } catch { /* skip */ }
  }
}

// Strip frame-blocking headers for twitch.tv so the full popout chat (which is
// send-capable, unlike the read-oriented embed) can load inside our panel.
function allowTwitchFraming() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const h = details.responseHeaders;
    if (h) for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options') delete h[k];
      else if (lk === 'content-security-policy') h[k] = h[k].map(v => v.replace(/frame-ancestors[^;]*(;|$)/gi, ''));
    }
    cb({ responseHeaders: h });
  });
}

// Remember which child windows (Bag, Passives, chat popout) were open and where,
// plus the main window's bounds, and restore them next launch. State lives in
// userData — the main process has no localStorage. One entry per page/host.
const winStateFile = () => path.join(app.getPath('userData'), 'windows.json');
const readWinState = () => { try { return JSON.parse(fs.readFileSync(winStateFile(), 'utf8')); } catch { return {}; } };
const writeWinState = (s) => { try { fs.writeFileSync(winStateFile(), JSON.stringify(s)); } catch {} };
function winKey(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') return u.pathname;   // /bag.html, /passives.html
    if (u.hostname.endsWith('twitch.tv')) return 'twitch-chat';
  } catch {}
  return null; // anything else isn't a window we manage
}
function initWindowPersistence(win, state) {
  const saveMain = () => { if (!win.isDestroyed()) { state.main = { ...(state.main || {}), ...win.getBounds() }; writeWinState(state); } };
  win.on('moved', saveMain); win.on('resized', saveMain);
  // App shutdown closes every child window, and those close events used to be
  // indistinguishable from the user closing a window — each one stamped
  // open:false, so a restart never had anything to reopen. Once the main
  // window (or the app) starts closing, child closes stop counting as
  // "user closed this".
  let closing = false;
  // If a close gets canceled the main window survives — reset so later child
  // closes count as user actions again.
  const markClosing = () => { closing = true; setTimeout(() => { if (!win.isDestroyed()) closing = false; }, 1000); };
  win.on('close', markClosing);
  app.on('before-quit', markClosing);
  // Apply saved bounds to each child as it opens (keyed by its URL).
  win.webContents.setWindowOpenHandler(({ url }) => {
    const s = state[winKey(url)] || {};
    const bounds = s.x != null ? { x: s.x, y: s.y, width: s.width, height: s.height } : {};
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#0c0a16', ...bounds } };
  });
  win.webContents.on('did-create-window', (child, { url }) => {
    const key = winKey(url); if (!key) return;
    state[key] = { ...(state[key] || {}), url, open: true, ...child.getBounds() };
    writeWinState(state);
    const save = () => { if (!child.isDestroyed()) { state[key] = { ...state[key], ...child.getBounds() }; writeWinState(state); } };
    child.on('moved', save); child.on('resized', save);
    child.on('close', () => { if (!closing && state[key]) { state[key].open = false; writeWinState(state); } });
  });
  // Reopen whatever was open last session once the main page can host window.open
  // (its handler above then applies the saved bounds). ponytail: no off-screen
  // clamp — if the monitor layout changed a window may land off-screen; move it.
  win.webContents.once('did-finish-load', () => {
    for (const [key, s] of Object.entries(state)) {
      if (key === 'main' || !s.open || !s.url) continue;
      const feat = `width=${s.width || 1000},height=${s.height || 800}`;
      win.webContents.executeJavaScript(
        `window.open(${JSON.stringify(s.url)}, ${JSON.stringify(key)}, ${JSON.stringify(feat)})`
      ).catch(() => {});
    }
  });
}

async function start() {
  allowTwitchFraming();
  await load7tv(); // custom emotes in chat, if 7TV is installed
  const dir = await resolveAppDir(); // bundled, or a newer set pulled from the repo
  await loadItemLinks(dir); // hover cards for shared item links in chat
  process.env.INSTALL_ID = installId(); // anonymous, for usage stats
  global.__autoUpdate = true; // this (installer) shell self-updates; the bridge reports it so the
                              // hot-updated UI can warn old portable shells, which never set this
  global.__version = app.getVersion(); // the app's semver — the single user-facing version
  // Disk fight-logs: the bridge owns writing/pruning; the shell only provides
  // the location and a safe way to show it (no shell-string interpolation).
  global.__fightLogsDir = path.join(app.getPath('userData'), 'fight-logs');
  global.__openPath = (p) => shell.openPath(p);
  // The bundled install, for files the hot-update path can't carry — it writes
  // everything as text, so images live here and only here (see the bridge's
  // static fallback).
  global.__bundledDir = __dirname;
  // Where the bridge's own hot-update writes must land. NOT wherever it happens
  // to be running from: `dir` above is the install directory whenever the
  // bundled revision is the newer one, and that is read-only on Windows.
  global.__appDir = path.join(app.getPath('userData'), 'app');
  // Operator secret for /broadcast and /feedback-recent — the real auth for
  // those, never shipped in the client (H3). Only the operator has it: set env
  // POD_OWNER_KEY, or drop the key into userData/operator-key. Absent for
  // everyone else, so their bridge can't push banners or read feedback contacts.
  try {
    global.__operatorKey = (process.env.POD_OWNER_KEY
      || fs.readFileSync(path.join(app.getPath('userData'), 'operator-key'), 'utf8')).trim() || null;
  } catch { global.__operatorKey = null; }
  const bridge = await import(pathToFileURL(path.join(dir, 'server.mjs')).href); // starts bridge on :8787
  const actions = await import(pathToFileURL(path.join(dir, 'actions.mjs')).href);
  const { GAME_NAME } = await import(pathToFileURL(path.join(dir, 'config.mjs')).href);
  await bridge.ready; // resolves when .listen() is accepting

  const winState = readWinState();
  const mb = winState.main || {};
  const win = new BrowserWindow({
    width: mb.width || 1440, height: mb.height || 900,
    ...(mb.x != null && mb.y != null ? { x: mb.x, y: mb.y } : {}),
    backgroundColor: '#0c0a16', autoHideMenuBar: true, title: GAME_NAME,
    // Always the bundled copy, never the hot-updated dir — the updater writes
    // files as text, so binaries only ever arrive with the installer. Packaged
    // builds take the icon off the exe anyway; this is what dev runs show.
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  initWindowPersistence(win, winState); // remember main + child windows across launches

  // Log in once (persisted across launches); reuse the saved session thereafter.
  let advSession = await getAdvSession();
  if (!advSession) advSession = await runLogin(win);

  actions.setCookie(`adv_session=${advSession}`); // the bridge now acts as this user
  // A persisted cookie can be invalidated server-side; without this check the
  // UI's "restart to re-login" advice loops forever on the same dead cookie
  // (runLogin resolves instantly while the stale cookie still exists).
  try { await actions.getAuthed('/inventory'); }
  catch (e) {
    if (e.expired) {
      await session.defaultSession.cookies.remove(SITE, 'adv_session').catch(() => {});
      advSession = await runLogin(win);
      actions.setCookie(`adv_session=${advSession}`);
    } // site-down errors fall through to the normal downtime handling
  }
  await relaxTwitchCookies();                     // make the chat embed see the login
  await session.defaultSession.clearCache().catch(() => {}); // drop stale cached app files
  win.loadURL(`http://localhost:${PORT}/`);
  // Authoritative keyboard-focus restore for the chat iframe: after toast
  // interactions the cross-origin (OOPIF) chat frame can go deaf to keys, and
  // renderer-side focus() alone doesn't always recover it. The bridge exposes
  // this via /api/refocus.
  global.__refocus = () => { if (!win.isDestroyed()) { win.focus(); win.webContents.focus(); } };
  initAutoUpdate(); // background: full-app update via electron-updater
}

app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
