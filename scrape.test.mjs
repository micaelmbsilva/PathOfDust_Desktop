// Scrape smoke-test: node scrape.test.mjs
// Guards the item-implicit parse against the site's real markup (see
// item_card_body_html / unique_affix_html / sacred_affix_html in PathofDust's
// src/adventure_web.rs) — a Sacred item that ALSO carries a unique affix
// (Celestial Shard) must yield both lines, each with its own colour flag.
import assert from 'node:assert/strict';
import { implicitsOf } from './server.mjs';

// The site's order inside a .gear-slot: name, quality, primary, sacred, unique.
const sacredAndUnique = `
  <div class="gear-name gear-name-sacred">Celestial Hood</div>
  <div class="gear-quality gear-quality--sacred" data-tip="...">Sacred</div>
  <div class="gear-primary">+412 dps</div>
  <div class="gear-sacred">&#10022; Sacred: +224% splash damage</div>
  <div class="gear-unique">&#10022; Celestial Conversion: Deals 10% of each heal as bonus damage</div>
  <div class="gear-tier">Tier 17</div>`;

const got = implicitsOf(sacredAndUnique);
assert.equal(got.length, 2, 'both implicit lines survive');
assert.match(got[0].t, /^Sacred: \+224% splash damage$/);
assert.equal(got[0].gold, false, 'Sacred line stays icy blue');
assert.match(got[1].t, /^Celestial Conversion: Deals 10%/);
assert.equal(got[1].gold, true, 'unique line is gold');

// Unique-only and plain items still behave.
assert.deepEqual(implicitsOf('<div class="gear-unique">&#10022; Split Personality: +1 passive point</div>'),
  [{ t: 'Split Personality: +1 passive point', gold: true }]);
assert.deepEqual(implicitsOf('<div class="gear-name">Rusty Cap</div><div class="gear-quality">Quality 41%</div>'), []);

console.log('ok');
process.exit(0); // importing server.mjs opens the bridge listener
