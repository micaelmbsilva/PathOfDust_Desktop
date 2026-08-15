// Electron shell: starts the bridge in-process and shows it in a real app
// window. Standalone .exe (bundled Chromium). Multi-user: no tokens are shipped —
// each user logs in once via the site's Twitch OAuth, and that one login drives
// everything (site session for stats/bag/passives/actions, and Twitch chat).
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const http = require('node:http');

const PORT = 8787;
const SITE = 'https://adventure.lokati.net';
const SEVENTV_ID = 'lppmekppnliemjclknbagdhoocikieoi';

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

async function start() {
  await load7tv(); // custom emotes in chat, if 7TV is installed
  await import(pathToFileURL(path.join(__dirname, 'server.mjs')).href); // starts bridge on :8787
  const actions = await import(pathToFileURL(path.join(__dirname, 'actions.mjs')).href);
  await waitForPort();

  const win = new BrowserWindow({
    width: 1440, height: 900, backgroundColor: '#0c0a16', autoHideMenuBar: true, title: 'Adventure',
  });
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#0c0a16' },
  }));

  // Log in once (persisted across launches); reuse the saved session thereafter.
  let advSession = await getAdvSession();
  if (!advSession) advSession = await runLogin(win);

  actions.setCookie(`adv_session=${advSession}`); // the bridge now acts as this user
  await relaxTwitchCookies();                     // make the chat embed see the login
  win.loadURL(`http://localhost:${PORT}/`);
}

app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
