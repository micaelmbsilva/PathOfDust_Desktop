// Smallest checks that fail if the scrapers stop understanding the game's markup,
// or if posted findings stop being validated. Run: node test-server.js
const assert = require('assert');
const { parsePatchNotes, badFindings } = require('./index.js');

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

// --- posted findings are shape-checked before they can reach the watchlist ---
const ok = { summary: 's', interactions: [{ title: 'T', text: 'X', impact: 'high', classes: ['Monk'], rolls: ['Block'] }] };
assert.strictEqual(badFindings(ok), null, 'a well-formed body passes');
assert.strictEqual(badFindings({ interactions: [{ title: 'T', text: 'X' }] }), null, 'optional fields stay optional');
assert.ok(badFindings(null), 'null body rejected');
assert.ok(badFindings([]), 'array body rejected');
assert.ok(badFindings({ interactions: [] }), 'empty interactions rejected — it would blank the watchlist');
assert.ok(badFindings({ interactions: [{ text: 'X' }] }), 'missing title rejected');
assert.ok(badFindings({ interactions: [{ title: 'T' }] }), 'missing text rejected');
assert.ok(badFindings({ interactions: [{ title: 'T', text: 'X', impact: 'huge' }] }), 'unknown impact rejected');
assert.ok(badFindings({ interactions: [{ title: 'T', text: 'X', classes: 'Monk' }] }), 'classes must be an array');
assert.ok(badFindings({ ...ok, patterns: 'nope' }), 'patterns must be an array');
assert.ok(badFindings({ interactions: [{ title: ' '.repeat(300), text: 'X' }] }), 'whitespace title rejected, not stored blank');
assert.ok(badFindings({ interactions: [{ title: 'T', text: 'X', classes: ['Monk', ' '] }] }), 'blank class entry rejected');
assert.ok(badFindings({ interactions: [{ title: 'T', text: 'X', rolls: [42] }] }), 'non-string roll rejected');
// Oversized lists are refused, not truncated — a silent trim would delete coverage.
const many = (n) => Array.from({ length: n }, (_, k) => ({ title: 'T' + k, text: 'X' }));
assert.strictEqual(badFindings({ interactions: many(200) }), null, '200 interactions is the limit, not over it');
assert.ok(badFindings({ interactions: many(201) }), '201 interactions rejected');
assert.ok(badFindings({ ...ok, patterns: many(101) }), '101 patterns rejected');
assert.ok(badFindings({ interactions: [{ title: 'T', text: 'X', classes: Array(21).fill('Monk') }] }), '21 classes rejected');

console.log('parsers + findings validation OK');
