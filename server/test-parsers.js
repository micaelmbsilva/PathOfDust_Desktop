// Smallest check that fails if the scrapers stop understanding the game's markup.
// Run: node test-parsers.js
const assert = require('assert');
const { parsePatchNotes } = require('./index.js');

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

console.log('parsers OK');
