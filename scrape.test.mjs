// Scrape smoke-test: node scrape.test.mjs
// Guards the item-implicit parse against the site's real markup (see
// item_card_body_html / unique_affix_html / sacred_affix_html in PathofDust's
// src/adventure_web.rs) — a Sacred item that ALSO carries a unique affix
// (Celestial Shard) must yield both lines, each with its own colour flag.
import assert from 'node:assert/strict';
import { implicitsOf, repairOf, durabilityOf, treeOf, fightsOf, rosterOf, characterOf, nameItemOf } from './server.mjs';
import { netKey } from './actions.mjs';

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

// --- Repair (render_repair_form). The site emits NOTHING when an item is fine,
// so "no form" must read as "nothing to repair", not as a zero-cost repair.
const damaged = `<div class="durability-bar"><div class="durability-fill critical" style="width:0%"></div></div>` +
  `<span class="durability-pct">0%</span><div class="needs-repair">Needs repair — 0 bonus</div>` +
  `<form method="post" action="/repair-item"><input type="hidden" name="item_id" value="itm_7">` +
  `<button class="btn-sm btn-repair" type="submit">Repair (240d)</button></form>`;
assert.deepEqual(repairOf(damaged),
  { endpoint: '/repair-item', field: 'item_id', value: 'itm_7', cost: 240, disabled: false });
assert.equal(repairOf('<div class="gear-name">Fine Cap</div>'), null, 'no form = nothing to repair');
assert.equal(repairOf(damaged.replace('type="submit"', 'type="submit" disabled')).disabled, true,
  'too poor to repair');
const worn = `<form method="post" action="/repair-equipped"><input type="hidden" name="slot" value="weapon">` +
  `<button class="btn-sm btn-repair" type="submit">Repair (90d)</button></form>`;
assert.deepEqual(repairOf(worn),
  { endpoint: '/repair-equipped', field: 'slot', value: 'weapon', cost: 90, disabled: false });

// --- Durability: a bar, the indestructible word, or nothing at all.
assert.deepEqual(durabilityOf(damaged), { pct: 0, indestructible: false });
assert.deepEqual(durabilityOf('<span class="indestructible">Indestructible</span>'),
  { pct: null, indestructible: true });
assert.equal(durabilityOf('<div class="gear-name">x</div>'), null);

// --- Tree. The read-only pages carry no <form>, so their nodes have no
// node_key — the parser must still keep them (the old one dropped every one).
const roNode = `<svg class="connectors" width="900" height="400">` +
  `<line x1="10.0" y1="20.0" x2="30.0" y2="40.0" stroke="#7a6ba8" stroke-width="2"></line></svg>` +
  `<div class="node node-skill node--maxed" style="left:120px;top:58px;width:140px;" data-tip="Hits harder.">` +
  `<div class="node-kind">Tier 1</div><div class="node-name">Cleave</div>` +
  `<div class="dots"><span class="dot filled"></span></div>` +
  `<div class="node-buttons"><span class="node-rank">3/3</span></div></div>`;
const ro = treeOf(roNode);
assert.deepEqual(ro.stage, { w: 900, h: 400 });
assert.deepEqual(ro.edges, [{ x1: 10, y1: 20, x2: 30, y2: 40 }]);
assert.equal(ro.nodes.length, 1, 'keyless read-only node survives');
assert.deepEqual([ro.nodes[0].name, ro.nodes[0].rank, ro.nodes[0].key, ro.nodes[0].canInc],
  ['Cleave', '3/3', null, false]);
assert.equal(treeOf(roNode, true).nodes[0].secondary, true, '2nd-class nodes are flagged for /allocate');

// --- Fights: gated for everyone but the streamer, and that must not look empty.
assert.deepEqual(fightsOf('<div class="card"><h1>Not Found</h1></div>'), { gated: true, fights: [] });
const fightPage = `<div class="card"><h1>Fight History</h1></div>` +
  `<div class="card"><h2>Boss — Stage 4 — Won</h2><p class="muted">2026-08-17 · 6 participants</p>` +
  `<h3>Battle Report</h3><ul><li>🗡️ Top DPS: a, b (12K)</li></ul>` +
  `<h3>Skills Cast</h3><ul><li>a — Cleave ×3</li></ul>` +
  `<h3>Buff/Debuff Stack Activity</h3><table class="buff-activity-table"><tbody>` +
  `<tr><td>a</td><td>Rage</td><td>5</td><td>2.00</td><td>3.00</td></tr></tbody></table>` +
  `<h3>Loot</h3><ul><li class="muted">None</li></ul>` +
  `<h3>Broken Gear</h3><ul><li>a — Rusty Cap</li></ul></div>`;
const f = fightsOf(fightPage);
assert.equal(f.gated, false);
assert.equal(f.fights.length, 1, 'header card is not a fight');
assert.equal(f.fights[0].won, true);
assert.deepEqual(f.fights[0].skills, ['a — Cleave ×3']);
assert.deepEqual(f.fights[0].loot, [], 'the muted "None" placeholder is not loot');
assert.deepEqual(f.fights[0].broken, ['a — Rusty Cap']);
assert.deepEqual(f.fights[0].buffs, [['a', 'Rage', '5', '2.00', '3.00']]);

// --- Roster (render_character_list). The login lives ONLY in the href — the
// card prints the display name, which is a different string.
const rosterPage = `<div class="roster-grid">
  <a class="roster-card" href="/characters/lokati_gaming">
    <img class="roster-sprite" src="/sprites/knight.png" alt="">
    <div class="roster-name">Lokati</div>
    <div class="roster-meta">Level 91 Slayer</div>
    <div class="roster-meta">140W / 30L (82%)</div></a>
  <a class="roster-card" href="/characters/newbie">
    <img class="roster-sprite" src="/sprites/x.png" alt="">
    <div class="roster-name">Newbie</div>
    <div class="roster-meta">Level 1 Commoner</div>
    <div class="roster-meta">0W / 0L (—)</div></a></div>`;
const rl = rosterOf(rosterPage);
assert.equal(rl.length, 2);
assert.deepEqual([rl[0].login, rl[0].name, rl[0].cls, rl[0].level, rl[0].wins, rl[0].losses, rl[0].winrate],
  ['lokati_gaming', 'Lokati', 'Slayer', 91, '140', '30', '82%']);
assert.match(rl[0].sprite, /^https:\/\/adventure\.lokati\.net\/sprites\/knight\.png$/, 'sprite URL is absolute');
assert.equal(rl[1].wins, '0');
assert.equal(rl[1].winrate, '—', 'no games played renders an em dash, not 0%');

// W/L pass through the site's format_number, so anyone past 1000 fights arrives
// abbreviated. Parsing these as \d+ silently produced 0W/0L for the whole
// roster — every character on the live site is well past that.
const abbrev = `<a class="roster-card" href="/characters/veteran">
  <div class="roster-name">Veteran</div>
  <div class="roster-meta">Level 121 Warlock</div>
  <div class="roster-meta">1.2KW / 340L (78%)</div></a>
  <a class="roster-card" href="/characters/ancient">
  <div class="roster-name">Ancient</div>
  <div class="roster-meta">Level 121 Druid</div>
  <div class="roster-meta">3.4MW / 1.1KL (75%)</div></a>`;
const ab = rosterOf(abbrev);
assert.deepEqual([ab[0].wins, ab[0].losses, ab[0].winrate], ['1.2K', '340', '78%']);
assert.deepEqual([ab[1].wins, ab[1].losses, ab[1].winrate], ['3.4M', '1.1K', '75%']);
assert.equal(ab[0].level, 121, 'level still parses alongside an abbreviated record');

// --- Another player's sheet. Empty gear slots must survive (the grid keeps its
// five cells); bag items must NOT be counted as equipped.
const charPage = `<div class="top-nav"></div><div class="card">
  <img class="sprite-avatar" src="/sprites/knight.png" alt="">
  <h1>Lokati</h1><span class="role-badge role-slayer">Slayer</span>
  <a class="passives-link-btn" href="/characters/lokati_gaming/passives">🌳 View Passive Tree</a>
  <div class="stat"><div class="stat-label">Level</div><div class="stat-value">91</div></div>
  <div class="stat"><div class="stat-label" data-tip="hp pool">Health</div><div class="stat-value" data-tip="base 100">40K</div></div>
  <div class="xp-label">XP: 832 / 9.1K</div><div class="xp-bar"><div class="xp-fill" style="width:9%"></div></div></div>
  <div class="card"><h2>Gear</h2><div class="gear-grid">
    <div class="gear-slot"><div class="gear-slot-label">Weapon</div>
      <div class="gear-name gear-name-sacred">Doom Edge</div>
      <div class="gear-quality gear-quality--sacred" data-tip="t">Sacred</div>
      <div class="gear-primary">+412 dps</div><div class="gear-tier">Tier 17</div>
      <div class="gear-stat"><ul><li class="mod-roll" data-tip="Roll: 97%">+18% crit chance</li></ul></div>
      <span class="indestructible">Indestructible</span></div>
    <div class="gear-slot empty"><div class="gear-slot-label">Helm</div><div class="gear-empty">— empty —</div></div>
  </div></div>
  <div class="card"><h2>Bag (1)</h2><div class="bag-rows">
    <details class="bag-row" open><summary>Boots (1)</summary><div class="bag-row-items">
      <div class="gear-slot"><div class="gear-slot-label">Boots</div>
        <div class="gear-name">Worn Sandals</div><div class="gear-quality">Quality 41%</div>
        <div class="gear-primary">+9 hp / 2.0s</div><div class="gear-tier">Tier 3</div>
        <div class="gear-stat"></div>
        <div class="durability-bar"><div class="durability-fill warn" style="width:35%"></div></div><span class="durability-pct">35%</span>
      </div></div></details></div></div>`;
const ch = characterOf(charPage, 'lokati_gaming');
assert.equal(ch.name, 'Lokati');
assert.equal(ch.archetype, 'Slayer');
assert.equal(ch.hasTree, true);
assert.equal(ch.xp.pct, 9);
assert.equal(ch.stats.length, 2, 'currency stats are NOT dropped for the in-app viewer');
assert.equal(ch.stats[1].vtip, 'base 100', 'breakdown tooltips hang off the value div');
assert.equal(ch.equipped.length, 2, 'the empty Helm slot keeps its cell');
assert.equal(ch.equipped[1].name, '', 'empty slot has no item name');
assert.deepEqual(ch.equipped[0].durability, { pct: null, indestructible: true });
assert.deepEqual(ch.equipped[0].mods, [{ t: '+18% crit chance', tip: 'Roll: 97%' }]);
assert.ok(!ch.equipped[0].repair, "another player's gear is never actionable");
assert.equal(ch.bag.length, 1, 'bag items are not mistaken for equipped');
assert.deepEqual(ch.bag[0].durability, { pct: 35, indestructible: false });
assert.deepEqual(characterOf('<div class="card"><h1>Not Found</h1></div>', 'nope'), { notFound: true });

// --- Traffic counter keys. Per-player pages must collapse into one bucket, or
// browsing the roster buries every other row under a hundred single-hit entries.
assert.equal(netKey('/'), '/');
assert.equal(netKey('inventory'), '/inventory', 'leading slash is optional at the call site');
assert.equal(netKey('/inventory'), '/inventory');
assert.equal(netKey('/characters'), '/characters', 'the roster list is not a per-player page');
assert.equal(netKey('/characters/lokati_gaming'), '/characters/*');
assert.equal(netKey('/characters/someone_else'), '/characters/*', 'two players, one bucket');
assert.equal(netKey('/characters/lokati_gaming/passives'), '/characters/*/passives');
assert.equal(netKey('/fights?limit=50'), '/fights', 'query strings are stripped');

// --- Krangle nickname prompt. Only Krangle earns one, the site asks once per
// item, and an EMPTY submission is how you decline -- so the card has to offer
// a Skip that posts, not one that just hides it.
const krangled = `<div class="card"><h2>Name Your Krangled Item</h2>
  <p class="muted">You Krangled a Celestial Axe — give it a custom name if you'd like! It'll show as
  Celestial Axe "Your Name" everywhere. Leave it blank to skip.</p>
  <form method="post" action="/name-item">
    <input type="hidden" name="item_id" value="itm_42">
    <input type="text" name="nickname" maxlength="30" placeholder="e.g. Excalibur">
    <button class="btn" type="submit">Save</button>
  </form></div>`;
assert.deepEqual(nameItemOf(krangled), { id: 'itm_42', maxLen: 30, name: 'Celestial Axe' });
assert.equal(nameItemOf('<div class="card"><h2>Bag (3/50)</h2></div>'), null, 'no prompt when nothing is pending');
assert.equal(nameItemOf(krangled.replace(/name="item_id"\s+value="[^"]+"/, '')), null,
  'a form with no item id is not actionable');

console.log('ok');
process.exit(0); // importing server.mjs opens the bridge listener
