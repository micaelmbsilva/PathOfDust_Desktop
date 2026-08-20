// Smallest checks that fail if the scrapers stop understanding the game's markup.
// Run: node test-server.js
const assert = require('assert');
const { parsePatchNotes, parseWiki } = require('./index.js');

const PATCH_HTML = `
<div class="card"><h1>Patch Notes</h1></div>
<div class="card"><h2>August 17, 2026</h2>
<h3>Perfect/Sacred Drop Changes</h3><ul><li>Sacred bases now drop from stage 200.</li><li>Perfect quality is unchanged.</li></ul>
<h3>Fixed a Real Boss-HP Overflow Bug</h3><ul><li>Boss HP no longer wraps past 2^31.</li></ul></div>
<div class="card"><h2>August 16, 2026</h2>
<h3>You Can Now View Other Players' Passive Trees</h3><p>Public tree pages are live.</p></div>
`;

const dates = parsePatchNotes(PATCH_HTML);
assert.strictEqual(dates.length, 2, 'two dated sections');
assert.strictEqual(dates[0].date, 'August 17, 2026');
assert.strictEqual(dates[0].entries.length, 2, 'two entries under the newest date');
assert.strictEqual(dates[0].entries[0].title, 'Perfect/Sacred Drop Changes');
assert.ok(dates[0].entries[0].text.includes('stage 200'), 'bullets joined into text');
assert.ok(dates[0].entries[0].text.includes(' • '), 'multiple bullets separated');
// Entries whose body is a <p> rather than a <ul> still carry their text.
assert.ok(dates[1].entries[0].text.includes('Public tree pages'), 'paragraph body parsed');
// Nothing parseable must not wipe a previous good scrape (caller keeps the old value).
assert.deepStrictEqual(parsePatchNotes('<div>no headings here</div>'), []);

// --- the wiki is a node graph: children sit centred under their parent ---
// Same shape as the live page (2026-08-17 redesign). A child is assigned to the
// nearest parent by x, so Thorned Hide (x=352) must land under Spike Barrier
// (x=446), not Aegis (x=164), even though it is drawn to the left of its parent.
const node = (kind, name, rank, tip, x, y) =>
  `<div class="node node-${kind}" style="left: ${x}px; top: ${y}px;" data-tip="${tip}">` +
  `<div class="node-name">${name}</div><div class="node-rank">${rank}</div></div>`;
const WIKI_HTML = `
<details class="wiki-archetype"><summary>🛡️ Warrior <span class="role-badge">Melee</span></summary>
${node('root', 'WARRIOR', '', '16% reduced damage taken', 1292, 58)}
${node('spec', 'Aegis', '4/4', 'A blocked hit shields your lowest-HP ally.', 164, 296)}
${node('spec', 'Spike Barrier', '4/4', 'A blocked hit reflects damage back.', 446, 296)}
${node('skill', 'Bulwark', '3/3', 'Grants a chance to block incoming hits.', 446, 178)}
${node('mod', 'Bastion', '3/3', "Aegis's shield lasts 1 additional second per rank.", 70, 402)}
${node('mod', 'Rally', '3/3', 'Aegis also grants the shielded ally attack speed.', 164, 402)}
${node('mod', 'Thorned Hide', '3/3', "Spike Barrier's reflect applies a damage debuff.", 352, 402)}
</details>`;

const wiki = parseWiki(WIKI_HTML);
assert.deepStrictEqual(Object.keys(wiki), ['Warrior'], 'archetype named from the summary');
assert.strictEqual(wiki.Warrior.role, 'Melee');
assert.ok(wiki.Warrior.root.includes('reduced damage taken'), 'root falls back to the root node tooltip');
const bulwark = wiki.Warrior.skills[0];
assert.strictEqual(bulwark.name, 'Bulwark');
assert.strictEqual(bulwark.max, '3/3', 'rank text kept as-is for display');
assert.deepStrictEqual(bulwark.specializations.map((s) => s.name), ['Aegis', 'Spike Barrier']);
assert.deepStrictEqual(bulwark.specializations[0].modifiers.map((m) => m.name), ['Bastion', 'Rally']);
assert.deepStrictEqual(bulwark.specializations[1].modifiers.map((m) => m.name), ['Thorned Hide'],
  'a mod drawn left of its parent still groups by nearest x');
assert.ok(bulwark.specializations[0].modifiers[0].text.includes('additional second'), 'tooltip carries the effect text');
assert.strictEqual(parseWiki('<div>not the wiki</div>').Warrior, undefined, 'unknown markup parses to nothing');

console.log('parsers + wiki OK');
