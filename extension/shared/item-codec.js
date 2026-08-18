// Path of Dust chat item-link codec — the payload contract for "#pod-item="
// share links (full spec in README.md). Canonical copy:
// pod_chat_extension/shared/item-codec.js; lokati_overlay/item-codec.js and
// lokati_overlay/extension/shared/item-codec.js must stay byte-identical
// (test/codec.test.mjs enforces it).
//
// Deliberately export-free: it attaches globalThis.PodItemCodec so the SAME
// file loads as a plain content script (manifest "js" list), a classic
// <script src> in bag.html, and an ES module in node tests.
//
// Payload: "1." + base64url(deflate-raw(UTF-8 JSON of the compact item)).
// Compact item: { n: name, s: slot, t: tierNumber, q: qualityText,
//   p: primaryStat, im: [implicitText...],
//   m: [[modText, rollPct|null, crit 1|0]...],
//   f: { sa: 1?, un: 1?, kr: 1? } (sacred / unique / krangled) }

(function () {
  const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => Uint8Array.from(
    atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const pipe = async (bytes, stream) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  async function encodeItem(item) {
    const raw = new TextEncoder().encode(JSON.stringify(item));
    return '1.' + b64url(await pipe(raw, new CompressionStream('deflate-raw')));
  }

  async function decodeItem(payload) {
    const m = /^1\.([A-Za-z0-9_-]+)$/.exec(payload || '');
    if (!m) throw new Error('unsupported pod-item payload');
    const raw = await pipe(unb64url(m[1]), new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(raw));
  }

  // Chat link for an encoded payload. login: sharer's Twitch login, or falsy to
  // link the site root. Non-extension clickers land on the game site either way.
  const itemLink = (payload, login) =>
    `https://adventure.lokati.net/${login ? 'characters/' + encodeURIComponent(login) : ''}#pod-item=${payload}`;

  // Matches pod-item links in chat text or hrefs. Group 1 = payload.
  const LINK_RE = /https:\/\/adventure\.lokati\.net\/(?:characters\/[\w.-]*)?#pod-item=(1\.[A-Za-z0-9_-]+)/;

  globalThis.PodItemCodec = { encodeItem, decodeItem, itemLink, LINK_RE };
})();
