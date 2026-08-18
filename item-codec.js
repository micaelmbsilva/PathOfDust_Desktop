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
// Payload: "<version>." + base64url(deflate-raw(UTF-8 JSON of the compact item)).
// Compact item (the shape encodeItem takes and decodeItem returns, both
// versions): { n: name, s: slot, t: tierNumber, q: qualityText,
//   p: primaryStat, im: [implicitText...],
//   m: [[modText, rollPct|null, crit 1|0]...],
//   f: { sa: 1?, un: 1?, kr: 1? } (sacred / unique / krangled) }
//
// Version 1 stores that object verbatim. Version 2 stores the SAME item as a
// positional array with every string the two ends already share replaced by a
// table index (see shrink/grow) — a fully loaded item drops from ~460 link
// characters to ~250, which is what keeps the share line under Twitch's
// 500-character cap without dropping any of the item's mods. Encoding stays
// version 1 by default because published extensions only match "1." links;
// bag.html reaches for version 2 only when version 1 will not fit.

(function () {
  const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => Uint8Array.from(
    atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const pipe = async (bytes, stream) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  // Every mod label the game can roll, in affix.rs's own order (the `label`
  // field of affix_def; IncreasedLife and FlatLife share "max hp", so it
  // appears once). These words are most of a loaded item's bytes and both ends
  // already know them, so v2 sends the index instead. A label the table does
  // not have — the game added or reworded one — falls back to the literal
  // text, so a stale table costs bytes, never information.
  const LABELS = [
    'dmg taken reduction', 'block chance', 'evasion', 'dmg dealt', 'crit chance',
    'crit dmg dealt', 'splash', 'lingering effect', 'intervene', 'life leech',
    'max hp',
    'cold damage (evasion debuff chance)',
    'fire damage (dmg reduction debuff chance)',
    'lightning damage (dmg taken debuff chance)',
    'divine damage (heal debuff/buff chance)',
    'chaos damage (block debuff chance)',
  ];
  const SLOTS = ['weapon', 'helm', 'body', 'gloves', 'boots'];
  const FLAGS = ['sa', 'un', 'kr'];

  // v2 body. null means "key absent" — no field of a compact item is ever
  // legitimately null (missing tier/quality/primary come through as undefined),
  // so grow() can restore exactly the keys the item had.
  const shrink = (it) => {
    const s = SLOTS.indexOf(it.s);
    const q = /^Quality (\d+(?:\.\d+)?)%$/.exec(it.q || '');
    return [
      it.n ?? null,
      it.s == null ? null : (s < 0 ? it.s : s),
      it.t ?? null,
      q ? +q[1] : (it.q ?? null),
      it.p ?? null,
      it.im || [],
      (it.m || []).map(([text, roll, crit]) => {
        // "+3.15% cold damage (evasion debuff chance)" -> value token + label.
        const sp = /^(\S+) (.+)$/.exec(text || '');
        const i = sp ? LABELS.indexOf(sp[2]) : -1;
        const e = i < 0 ? [null, text ?? null, roll ?? null] : [i, sp[1], roll ?? null];
        return crit ? e.concat(1) : e; // trailing 0 costs bytes; absent means not crit
      }),
      FLAGS.reduce((b, k, i) => b | (it.f && it.f[k] ? 1 << i : 0), 0),
    ];
  };

  const grow = ([n, s, t, q, p, im, m, f]) => {
    const it = {};
    if (n != null) it.n = n;
    if (s != null) it.s = typeof s === 'number' ? SLOTS[s] : s;
    if (t != null) it.t = t;
    if (q != null) it.q = typeof q === 'number' ? `Quality ${q}%` : q;
    if (p != null) it.p = p;
    it.im = im || [];
    it.m = (m || []).map(([l, v, roll, crit]) =>
      [l == null ? v : `${v} ${LABELS[l] ?? ''}`.trim(), roll ?? null, crit ? 1 : 0]);
    it.f = {};
    FLAGS.forEach((k, i) => { if (f & (1 << i)) it.f[k] = 1; });
    return it;
  };

  async function encodeItem(item, version = 1) {
    const body = version === 2 ? shrink(item) : item;
    const raw = new TextEncoder().encode(JSON.stringify(body));
    return version + '.' + b64url(await pipe(raw, new CompressionStream('deflate-raw')));
  }

  async function decodeItem(payload) {
    const m = /^([12])\.([A-Za-z0-9_-]+)$/.exec(payload || '');
    if (!m) throw new Error('unsupported pod-item payload');
    const raw = await pipe(unb64url(m[2]), new DecompressionStream('deflate-raw'));
    const body = JSON.parse(new TextDecoder().decode(raw));
    return m[1] === '2' ? grow(body) : body;
  }

  // Chat link for an encoded payload. login: sharer's Twitch login, or falsy to
  // link the site root. Non-extension clickers land on the game site either way.
  const itemLink = (payload, login) =>
    `https://adventure.lokati.net/${login ? 'characters/' + encodeURIComponent(login) : ''}#pod-item=${payload}`;

  // Matches pod-item links in chat text or hrefs. Group 1 = payload.
  const LINK_RE = /https:\/\/adventure\.lokati\.net\/(?:characters\/[\w.-]*)?#pod-item=([12]\.[A-Za-z0-9_-]+)/;

  globalThis.PodItemCodec = { encodeItem, decodeItem, itemLink, LINK_RE };
})();
