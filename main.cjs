// Electron shell: starts the bridge in-process and shows it in a real app
// window. Standalone .exe (bundled Chromium). Multi-user: no tokens are shipped —
// each user logs in once via the site's Twitch OAuth, and that one login drives
// everything (site session for stats/bag/passives/actions, and Twitch chat).
const { app, BrowserWindow, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const http = require('node:http');

// Keep third-party cookies working in the embedded Twitch chat (so it's logged
// in and you can actually send messages), and let us iframe the full popout chat.
app.commandLine.appendSwitch('disable-features', 'ThirdPartyStoragePartitioning,PartitionedCookies');

const PORT = 8787;
const SITE = 'https://adventure.lokati.net';
const SEVENTV_ID = 'lppmekppnliemjclknbagdhoocikieoi';
const REPO = 'micaelmbsilva/PathOfDust_Desktop';
let updatedTo = 0; // set by resolveAppDir when it pulls a newer version this launch

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
    if (manifest.version > Math.max(bundledVer, localVer)) {
      const files = await Promise.all(manifest.files.map(f => get(`${base}/${f}`).then(t => [f, t])));
      fs.mkdirSync(appDir, { recursive: true });
      for (const [f, t] of files) fs.writeFileSync(path.join(appDir, f), t); // all fetched before writing
      fs.writeFileSync(path.join(appDir, 'version.json'), JSON.stringify(manifest));
      localVer = manifest.version;
      updatedTo = manifest.version; // pulled a newer version this launch
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
  global.__applyUpdate = () => autoUpdater.quitAndInstall(); // called by /api/apply-update
  global.__checkUpdate = () => autoUpdater.checkForUpdates().catch(() => {}); // called by /api/check-update
  autoUpdater.autoDownload = true;
  // Publish update state on the global so the bridge can report it and the UI can
  // toast — "downloading" when found, "ready" once staged.
  autoUpdater.on('update-available', (i) => { global.__update = { status: 'downloading', version: i.version }; });
  autoUpdater.on('update-downloaded', (i) => { global.__update = { status: 'ready', version: i.version }; });
  autoUpdater.on('error', () => {}); // offline / feed hiccup — try again next launch
  autoUpdater.checkForUpdates().catch(() => {});
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

// A random, anonymous per-install id (no name/PII), persisted in userData.
function installId() {
  const f = path.join(app.getPath('userData'), 'install-id');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const id = require('node:crypto').randomUUID();
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(f, id); } catch {}
  return id;
}

const waitForPort = () => new Promise((resolve) => {
  const tick = () => http.get({ port: PORT, path: '/', timeout: 500 }, (r) => { r.destroy(); resolve(); })
    .on('error', () => setTimeout(tick, 150));
  tick();
});

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
    child.on('close', () => { if (state[key]) { state[key].open = false; writeWinState(state); } });
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
  process.env.INSTALL_ID = installId(); // anonymous, for usage stats
  global.__relaunch = () => { app.relaunch(); app.exit(0); }; // used by /api/restart to apply updates
  global.__autoUpdate = true; // this (installer) shell self-updates; the bridge reports it so the
                              // hot-updated UI can warn old portable shells, which never set this
  global.__version = app.getVersion(); // the app's semver — the single user-facing version
  await import(pathToFileURL(path.join(dir, 'server.mjs')).href); // starts bridge on :8787
  const actions = await import(pathToFileURL(path.join(dir, 'actions.mjs')).href);
  const { GAME_NAME } = await import(pathToFileURL(path.join(dir, 'config.mjs')).href);
  await waitForPort();

  const winState = readWinState();
  const mb = winState.main || {};
  const win = new BrowserWindow({
    width: mb.width || 1440, height: mb.height || 900,
    ...(mb.x != null && mb.y != null ? { x: mb.x, y: mb.y } : {}),
    backgroundColor: '#0c0a16', autoHideMenuBar: true, title: GAME_NAME,
  });
  initWindowPersistence(win, winState); // remember main + child windows across launches

  // Log in once (persisted across launches); reuse the saved session thereafter.
  let advSession = await getAdvSession();
  if (!advSession) advSession = await runLogin(win);

  actions.setCookie(`adv_session=${advSession}`); // the bridge now acts as this user
  await relaxTwitchCookies();                     // make the chat embed see the login
  await session.defaultSession.clearCache().catch(() => {}); // drop stale cached app files
  win.loadURL(`http://localhost:${PORT}/${updatedTo ? `?updated=${updatedTo}` : ''}`);
  initAutoUpdate(); // background: full-app update via electron-updater
}

app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
