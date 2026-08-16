// The one place to change the game/app display name. Used by the bridge (which
// serves it to the pages as window.GAME_NAME), the pages, and the Electron shell.
export const GAME_NAME = 'Path of Dust';
// Telemetry/feedback backend (the server/ app on Railway). Empty = disabled.
// Set to your Railway URL, e.g. 'https://pathofdust-production.up.railway.app'
export const TELEMETRY_URL = 'https://pathofdustdesktop-production.up.railway.app';
// Shared secret sent with telemetry pings; the backend rejects /ping without it
// once its PING_KEY env var is set. Keeps drive-by curl spam off the public ladder.
export const PING_KEY = 'e7c41c6f9a2d4b58c0f3a9d1765e8b24';
