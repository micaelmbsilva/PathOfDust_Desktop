// One-shot app launcher: starts the bridge, then opens it in a Chrome "app"
// window (no tabs/omnibox — reads as a native app). No Electron needed.
// Run: node app.mjs   (or double-click start.cmd)
import './server.mjs'; // starts the bridge on :8787
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const APP_URL = 'http://localhost:8787/';
const PROFILE = new URL('./.appchrome', import.meta.url).pathname.replace(/^\//, '');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].find(existsSync);

if (!CHROME) { console.log('Chrome not found — open ' + APP_URL + ' in any browser.'); }
else setTimeout(() => {
  spawn(CHROME, [`--app=${APP_URL}`, '--window-size=1440,900',
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore' }).unref();
  console.log('App window opening…  (bridge at ' + APP_URL + ')');
}, 700);
