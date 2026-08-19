// Scrape smoke-test: node scrape.test.mjs
// Guards the item-implicit parse against the site's real markup (see
// item_card_body_html / unique_affix_html / sacred_affix_html in PathofDust's
// src/adventure_web.rs) — a Sacred item that ALSO carries a unique affix
// (Celestial Shard) must yield both lines, each with its own colour flag.
import assert from 'node:assert/strict';
import { elementalOf, implicitsOf, repairOf, durabilityOf, treeOf, fightsOf, rosterOf, characterOf, nameItemOf, ownerBuildsAllowed, passivesOf, craftFormsOf, golemsOf } from './server.mjs';
import { netKey, firstBody, redirectNote } from './actions.mjs';
import { existsSync, readFileSync } from 'node:fs';

// Owner dossier: exact normalized login only. UI hiding is convenience; this
// pure predicate backs the bridge route and guards the template filename too.
assert.equal(ownerBuildsAllowed('lokati_gaming'), true);
assert.equal(ownerBuildsAllowed(' Lokati_Gaming '), true);
assert.equal(ownerBuildsAllowed('kibukah'), false);
assert.equal(ownerBuildsAllowed(''), false);

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
// The leading top-nav is what the real page carries and what firstBody's own
// test below cuts on — one per body copy.
const rosterPage = `<div class="top-nav"></div><div class="roster-grid">
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

// --- Total elemental damage is derived from the Increased Dmg Dealt hover, not
// re-added from gear rolls, so it can never disagree with the game's own number.
assert.equal(elementalOf(ch.stats), null, 'no elemental rolls -> no card at all');
const lines = (...l) => l.join('\n');
// "Increased Crit Dmg Dealt" sits immediately above the stat we want and also
// ends in "Dmg Dealt", but has no breakdown tooltip — matching it instead
// silently killed the card on every real character.
const el = elementalOf([
  { label: 'Increased Crit Dmg Dealt', value: '2455%', tip: 'x', vtip: '' },
  { label: 'Increased Dmg Dealt', value: '340%', tip: 'x',
    vtip: lines('Fire Damage: +12%', 'Lightning Damage: +9%', 'Gear (Increased Damage): +80%',
      'Passive Tree: +140%', 'Total: 340%') }]);
assert.equal(el.value, '21%', 'only the elemental lines are summed');
assert.equal(el.vtip, lines('Fire Damage: +12%', 'Lightning Damage: +9%', 'Total: +21%'));
assert.equal(elementalOf([{ label: 'Reduced Dmg Dealt', value: '5%', tip: 'x',
  vtip: lines('Archetype: -5%', 'Total: -5%') }]), null, 'no elemental lines -> null');

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


// --- The site's shell started rendering each page body TWICE inside one <head>,
// which put two of every stat card on the character sheet, two of every roster
// entry, two of every passive node. Every parser here sweeps a whole page, so
// the guard is one cut at the fetch: a second `class="top-nav"` starts a second
// copy. These fixtures are single-copy captures, so they double as the "healthy
// page is untouched" case.
const twice = (html) => {
  const i = html.indexOf('class="top-nav"');
  assert.ok(i > 0, 'fixture must carry exactly one top nav to be doubled');
  return html.slice(0, i) + html.slice(i) + html.slice(i);
};
for (const [label, page, parse] of [
  ['roster', rosterPage, (h) => rosterOf(h)],
  ['sheet', charPage, (h) => characterOf(h, 'lokati_gaming')],
]) {
  assert.equal(firstBody(page), page, `${label}: a single-copy page is returned unchanged`);
  assert.equal(firstBody(twice(page)), page, `${label}: the second copy is cut off`);
  assert.deepEqual(parse(firstBody(twice(page))), parse(page), `${label}: guarded, it parses once`);
}
// ...and would have doubled without the guard, which is the whole point.
assert.equal(rosterOf(twice(rosterPage)).length, rosterOf(rosterPage).length * 2, 'unguarded, the roster doubles');
assert.ok(characterOf(twice(charPage), 'lokati_gaming').stats.length > characterOf(charPage, 'lokati_gaming').stats.length,
  'unguarded, the stat sweep doubles');

// The captured pages under authed/ are real scrapes of live players, so they're
// gitignored and exist only on a machine that has actually pulled them. Run the
// same two assertions against that real markup when they're there — reading
// them unconditionally is what failed the v32.4.0 release build on a checkout
// that never had them. CI's coverage is the inline pair above.
for (const f of ['authed/characters.html', 'authed/characters_afrosenbo.html']) {
  if (!existsSync(f)) continue;
  const single = readFileSync(f, 'utf8');
  assert.equal(firstBody(single), single, `${f}: a single-copy page is returned unchanged`);
  assert.equal(firstBody(twice(single)), single, `${f}: the second copy is cut off`);
}

// --- /passives, as the site renders it since Memories (2026-08-19): a Memory
// slot card above the tree, and — with Split Personality equipped — a whole
// second tree below it. Markup copied from render_memories_section /
// render_passive_tree_page / render_ptree_body in PathofDust's adventure_web.rs.
const ptreeBody = (key, rank, secondaryTree) =>
  `<div class="tree-wrap"><div style="width:1180px;height:463px;position:relative;">` +
  `<svg class="connectors" width="1180" height="463">` +
  `<line x1="10.0" y1="20.0" x2="30.0" y2="40.0" stroke="#7a6ba8" stroke-width="2"></line></svg>` +
  `<div class="node node-root" style="left:480px;top:58px;width:220px;" data-tip="Big.">` +
  `<div class="node-kind">Class Passive &middot; Always Active</div>` +
  `<div class="node-name">${secondaryTree ? 'DRUID' : 'WARRIOR'}</div><div class="node-desc">Big.</div></div>` +
  `<div class="node node-skill node--invested" style="left:120px;top:180px;width:140px;" data-tip="Hits harder.">` +
  `<div class="node-kind">Tier 1</div><div class="node-name">${key}</div>` +
  `<div class="dots"><span class="dot filled"></span></div>` +
  `<form method="post" action="/passives/allocate" class="node-buttons">` +
  `<input type="hidden" name="node_key" value="${key}">` +
  `<input type="hidden" name="secondary" value="${secondaryTree}">` +
  `<button class="btn-sm" type="submit" name="delta" value="-1">-</button>` +
  `<span class="node-rank">${rank}</span>` +
  `<button class="btn-sm" type="submit" name="delta" value="1">+</button></form></div></div></div>`;

const memorySlot = (n, name) => name
  ? `<div class="memory-slot filled"><div class="memory-head">` +
    `<span class="memory-number">${n + 1}</span><span class="memory-name">${name}</span></div>` +
    `<div class="memory-meta">Warrior &amp; Druid &middot; 12 points spent</div>` +
    `<div class="memory-actions">` +
    `<form method="post" action="/passives/memories/load"><input type="hidden" name="slot" value="${n}">` +
    `<button class="btn-sm" type="submit">Load</button></form>` +
    `<form method="post" action="/passives/memories/save"><input type="hidden" name="slot" value="${n}">` +
    `<input type="hidden" name="name" value="${name}"><button class="btn-sm" type="submit">Overwrite</button></form>` +
    `</div></div>`
  : `<div class="memory-slot empty"><div class="memory-head">` +
    `<span class="memory-number">${n + 1}</span><span class="memory-name muted">Empty slot</span></div>` +
    `<form method="post" action="/passives/memories/save" class="memory-actions">` +
    `<input type="hidden" name="slot" value="${n}">` +
    `<input type="text" name="name" placeholder="Memories of an Elementalist" maxlength="150" aria-label="Name for Memory ${n + 1}">` +
    `<button class="btn-sm" type="submit">Save Current Build</button></form></div>`;

const passivesPage = (dirty, withSecondary) =>
  `<nav class="top-nav"><a class="top-nav-link" href="/">Home</a></nav><div class="ptree-page">` +
  `<div class="masthead"><div class="eyebrow">Live &middot; Warrior</div><h1>Passives</h1></div>` +
  `<div class="current-row"><div class="side-chips">` +
  `<div class="points-chip">&#129683; <span>Skill Points</span> &middot; <strong>3/12 unspent</strong></div>` +
  `<div class="preview-row">` +
  `<form method="post" action="/passives/save"><button class="btn-save" type="submit"${dirty ? '' : ' disabled'}>Save Changes</button></form>` +
  `<form method="post" action="/passives/reset"><button class="btn-respec" type="submit"${dirty ? '' : ' disabled'}>Reset Preview</button></form>` +
  `</div><p class="preview-note${dirty ? ' dirty' : ''}">${dirty ? 'Unsaved changes.' : 'No unsaved changes.'}</p>` +
  `<form method="post" action="/passives/respec"><button class="btn-respec" type="submit">Respec (Free)</button></form>` +
  `</div></div>` +
  `<div class="ptree-memories"><div class="masthead"><h1>Memories</h1></div><div class="memory-slots">` +
  memorySlot(0, 'Fire &amp; Fury') + memorySlot(1, null) + memorySlot(2, null) + `</div></div>` +
  ptreeBody('cleave', '2/3', false) +
  (withSecondary
    ? `<div class="ptree-secondary"><div class="masthead"><h1>2nd Class</h1></div>` +
      `<form method="post" action="/passives/set-secondary" class="secondary-picker">` +
      `<select id="secondary-archetype-select" name="archetype">` +
      `<option value="druid" selected>Druid</option><option value="rogue">Rogue</option></select>` +
      `<button class="btn-sm" type="submit">Change</button></form>` +
      ptreeBody('barkskin', '1/3', true) + `</div>`
    : ``) +
  `<footer>Root passive numbers mirror <code>Archetype::bonus()</code>.</footer></div>`;

const pv = passivesOf(passivesPage(true, true));
assert.equal(pv.points, '3/12 unspent');
assert.equal(pv.respecLabel, 'Respec (Free)');
assert.equal(pv.canSave, true);
assert.equal(pv.canReset, true);
assert.equal(pv.dirty, true);
// The Memories card sits ABOVE the tree — it must not leak into either canvas.
assert.deepEqual(pv.memories.map(m => [m.slot, m.filled, m.name]),
  [[0, true, 'Fire & Fury'], [1, false, ``], [2, false, ``]]);
assert.equal(pv.memories[0].meta, 'Warrior & Druid · 12 points spent');
assert.equal(pv.memories[1].placeholder, 'Memories of an Elementalist');
// No golem picker unless the character is an Elementalist with Golem Master.
assert.deepEqual(pv.golems, []);
// Two trees, never mixed: the primary canvas must not pick up the 2nd class's
// nodes, and the 2nd class's must not pick up the primary's.
assert.deepEqual(pv.nodes.map(n => n.name), ['WARRIOR', 'cleave']);
assert.equal(pv.nodes.every(n => n.secondary === false), true);
assert.deepEqual(pv.secondary.nodes.map(n => n.name), ['DRUID', 'barkskin']);
assert.equal(pv.secondary.nodes.every(n => n.secondary === true), true);
assert.deepEqual(pv.secondary.options.map(o => [o.value, o.selected]), [['druid', true], ['rogue', false]]);
assert.equal(pv.secondary.buttonLabel, 'Change');

// No Split Personality equipped: no 2nd tree at all, and the Memories card
// still parses (empty slots are the feature's entry point, always rendered).
const solo = passivesOf(passivesPage(false, false));
assert.equal(solo.secondary, null);
assert.equal(solo.memories.length, 3);
// The reset form is ALWAYS rendered and merely disabled — testing for the form
// alone reported "resettable" on every load.
assert.equal(solo.canReset, false, 'a disabled Reset Preview is not resettable');
assert.equal(solo.canSave, false);
assert.equal(solo.dirty, false);

// --- A refused action 303s to ?passive_failed=<reason>. That is a <400 status,
// so `ok` alone read every refusal as success and the click silently did
// nothing — worst with Split Personality, where two trees share one point pool.
assert.deepEqual(redirectNote('/passives?passive_failed=You%20have%20no%20points%20left.'),
  { reason: 'You have no points left.' });
assert.deepEqual(redirectNote('/passives?memory_note=You%27re%20now%20playing%20Druid.'),
  { note: "You're now playing Druid." });
assert.equal(redirectNote('/passives'), null);
assert.equal(redirectNote(null), null);

// --- Two forms POST to /craft since Divine Dust (Aug '26), and the recipe row
// renders FIRST. Taking "the chunk after the first action=/craft" therefore
// picked the recipe and left the item form — every craft option and button —
// empty. Markup mirrors render_divine_dust_recipe_row/render_crafting_card.
const inventoryPage = (disabled) => `
  <div class="card" id="crafting-card">
  <form method="post" action="/craft"><input type="hidden" name="action" value="divine dust craft">
    <div class="craft-actions">
      <span class="muted" data-tip="Costs dust + sand, not Divine Dust itself.">Craft Divine Dust (1000d + 10s → 1 ✨):</span>
      <label class="batch-check"><input type="radio" name="times" value="1" checked> x1</label>
      <button class="btn-sm" type="submit"${disabled ? ' disabled' : ''}>Craft</button>
    </div></form>
  <form method="post" action="/craft">
    <select name="item_a"><option value="itm_1" data-tier="7" data-sacred="1">Hood</option></select>
    <div class="craft-actions">
      <button class="btn-sm" type="submit" name="action" value="divine dust" data-divine-dust-apply="1" data-divine-dust="50" data-tip="2 per tier.">Apply Divine Dust</button>
    </div></form></div>`;

const cf = craftFormsOf(inventoryPage(false));
assert.match(cf.craftForm, /name="item_a"/, 'the item form is the one carrying item_a, not the recipe');
assert.match(cf.craftForm, /data-divine-dust-apply/, 'and it keeps the apply button');
assert.deepEqual({ ...cf.divineDustRecipe, tip: undefined },
  { action: 'divine dust craft', dustCost: 1000, sandCost: 10, output: 1, affordable: true, tip: undefined });
assert.match(cf.divineDustRecipe.tip, /^Costs dust \+ sand/);
assert.equal(craftFormsOf(inventoryPage(true)).divineDustRecipe.affordable, false, 'a disabled Craft button = cannot afford');
// A pre-Divine-Dust page (one craft form, no recipe) must still parse.
const old = craftFormsOf('<form method="post" action="/craft"><select name="item_a"></select></form>');
assert.equal(old.divineDustRecipe, null);
assert.match(old.craftForm, /name="item_a"/);

// --- Golem slots (render_golem_slots): Elementalist only, one form per slot
// Golem Master unlocked. Slot identity is the site's own number, so a picker
// list must never be re-indexed from its position.
const golemPage = `<div class="golem-slots"><div class="masthead"><h1>Golem Slots</h1></div>` +
  [0, 1].map(i => `<form method="post" action="/passives/set-golem-type" class="golem-slot-picker">` +
    `<input type="hidden" name="slot" value="${i}">` +
    `<label>Golem ${i + 1}</label>` +
    `<select name="golem_type">` +
    `<option value="basic"${i ? ' selected' : ''}>Basic</option>` +
    `<option value="thunder"${i ? '' : ' selected'}>Thunder</option>` +
    `<option value="flame">Flame</option><option value="water">Water</option></select>` +
    `<button class="btn-sm" type="submit">Set</button></form>`).join('') + `</div>`;
const gs = golemsOf(golemPage);
assert.equal(gs.length, 2);
assert.deepEqual(gs.map(g => [g.slot, g.label, g.type]), [[0, 'Golem 1', 'thunder'], [1, 'Golem 2', 'basic']]);
assert.deepEqual(gs[0].options.map(o => o.value), ['basic', 'thunder', 'flame', 'water']);
assert.equal(gs[0].options[1].label, 'Thunder', 'option values are lowercase, labels are not');
assert.deepEqual(golemsOf('<div class="ptree-page"></div>'), [], 'no picker for a non-Elementalist');

// --- A live-retuned node. The site appends its "Tuned:" span to data-tip
// UNESCAPED, so the span's own class quote closes the attribute early and the
// span lands as sibling markup — the description must not keep the fragment.
const tunedNode = `<svg class="connectors" width="900" height="400"></svg>` +
  `<div class="node node-skill" style="left:120px;top:58px;width:140px;" data-tip="Hits harder. <span class="passive-tuned">Tuned: 0.2 / 0.4 / 0.6 (default 0.1 / 0.2 / 0.3)</span>">` +
  `<div class="node-kind">Tier 1</div><div class="node-name">Cleave</div>` +
  `<div class="node-buttons"><span class="node-rank">1/3</span></div></div>`;
const tn = treeOf(tunedNode).nodes[0];
assert.equal(tn.tuned, 'Tuned: 0.2 / 0.4 / 0.6 (default 0.1 / 0.2 / 0.3)');
assert.equal(tn.desc, 'Hits harder.', 'the truncated attribute tail is not part of the description');
assert.equal(treeOf(roNode).nodes[0].tuned, null, 'an untuned node carries no note');

console.log('ok');
process.exit(0); // importing server.mjs opens the bridge listener
