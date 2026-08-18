// Guards the item-link codec that the Share button and the chat extension both
// depend on. The canonical, fuller suite lives in pod_chat_extension (it also
// checks card.js/content.js/tooltip.css against their copies here); this one
// exists so CI's verify job can't publish a codec that lost information or
// outgrew Twitch's message cap.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Export-free on purpose — the same file is a content script, a classic
// <script src> in bag.html, and this import. It attaches globalThis.
await import('./item-codec.js');
const { encodeItem, decodeItem, itemLink, LINK_RE } = globalThis.PodItemCodec;

assert.equal(
  readFileSync('./extension/shared/item-codec.js', 'utf8'),
  readFileSync('./item-codec.js', 'utf8'),
  'extension/shared/item-codec.js drifted from item-codec.js');

// A maxed elemental item — five long labels, a Sacred line AND a unique line —
// is the worst case the Share button has to fit into one chat message.
const maxed = {
  n: 'Ascended Celestial Hood of the Vast Expanse', s: 'helm', t: 119, q: 'Sacred',
  p: '+412 dps',
  im: ['Sacred: +224% splash damage',
    'Celestial Conversion: Deals 10% of each heal as bonus damage'],
  m: [
    ['+3.15% cold damage (evasion debuff chance)', 87, 0],
    ['+2.94% fire damage (dmg reduction debuff chance)', 72.5, 1],
    ['+2.71% lightning damage (dmg taken debuff chance)', 66, 0],
    ['+57% dmg dealt', 92, 0],
    ['+1,234 max hp', null, 0],
  ],
  f: { sa: 1, un: 1 },
};
const plain = {
  n: 'Rusty Cap', s: 'helm', t: 17, q: 'Quality 41%', p: '+80 dps',
  im: [], m: [['+50% dmg dealt', 45, 0], ['+12% crit chance', 30, 0]], f: {},
};
// An affix the label table doesn't know (the game added or reworded one) must
// survive as literal text rather than decoding to the wrong mod.
const odd = {
  n: 'X', s: 'helm', im: [], f: {},
  m: [['+9% brand new affix nobody has yet', 50, 1], ['no value token here', null, 0]],
};

for (const item of [maxed, plain, odd]) {
  for (const version of [1, 2]) {
    const payload = await encodeItem(item, version);
    assert.match(payload, new RegExp(`^${version}\.[A-Za-z0-9_-]+$`));
    assert.deepEqual(await decodeItem(payload), item, `v${version} lost data on ${item.n}`);
    const m = LINK_RE.exec(`chat text ${itemLink(payload, 'lokati_gaming')} more text`);
    assert.ok(m && m[1] === payload, `LINK_RE missed a v${version} link`);
  }
}

// bag.html never trims the link — it's the item's only complete copy — so the
// header it also never trims has to fit beside it inside Twitch's 500 chars.
const header = '✨ Ascended Celestial Hood of the Vast Expanse 【🪖 Helm · T119 · ✦Sacred】 +412 dps';
const fits = async (v) => header.length + 1 + itemLink(await encodeItem(maxed, v), 'lokati_gaming').length;
assert.ok(await fits(1) > 500, 'v1 got small enough that v2 has no reason to exist');
assert.ok(await fits(2) <= 500, `header + v2 link is ${await fits(2)} chars, over Twitch's 500`);

// Unknown versions and garbage must throw, never mis-decode.
await assert.rejects(() => decodeItem('3.abc'));
await assert.rejects(() => decodeItem('2.abc'));
await assert.rejects(() => decodeItem('not a payload'));

console.log(`codec ok — maxed share line ${await fits(2)} chars (v1 would be ${await fits(1)})`);
