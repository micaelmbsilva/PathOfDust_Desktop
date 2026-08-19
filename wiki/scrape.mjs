// Scrape the public game wiki (https://adventure.lokati.net/wiki) into
// structured JSON for reuse (e.g. a future website). No deps.
// Run: node wiki/scrape.mjs   -> writes wiki/wiki.json + wiki/wiki.html
import { writeFile } from 'node:fs/promises';

// The wiki became a multi-page docs site on 2026-08-19 — /wiki is now an index
// of links with no content of its own, so both sections moved to their own page.
// Scraping /wiki alone silently produced 0 bosses and 0 classes.
const ORIGIN = 'https://adventure.lokati.net';
const URL_ = `${ORIGIN}/wiki`;
const strip = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, '')
  .replace(/\s+/g, ' ').trim();
const paras = (html) => [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1]));

const page = async (path) => {
  const res = await fetch(ORIGIN + path);
  if (!res.ok) throw new Error(`wiki fetch failed: ${path} ${res.status}`);
  return res.text();
};
const [bossPage, t] = await Promise.all([page('/wiki/bosses'), page('/wiki/passives')]);

// ---- Bosses: one h3 per boss, inside the page's content column ----
const bossRegion = (bossPage.split('class="wiki-content"')[1] || bossPage).split('<footer')[0];
const bossIntro = paras(bossRegion.split('<h3')[0]);
const bosses = bossRegion.split('<h3').slice(1).map(chunk => ({
  name: strip(chunk.slice(chunk.indexOf('>') + 1, chunk.indexOf('</h3>'))),
  text: paras(chunk).join('\n\n'),
}));

// ---- Classes: <details class="... wiki-archetype"> blocks ----
const classes = t.split(/<details class="[^"]*wiki-archetype[^"]*">/).slice(1).map(block => {
  block = block.split('</details>')[0];
  const summary = strip((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '');
  const role = (block.match(/role-badge[^>]*>([^<]*)</) || [])[1] || '';
  const rootPassive = strip((block.match(/wiki-root-desc[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
  const skills = block.split('<div class="wiki-skill">').slice(1).map(sk => {
    const h3 = (sk.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || '';
    const skill = {
      name: strip(h3.split('<span')[0]),
      max: (strip(h3).match(/max\s+([\d/]+)/) || [])[1] || '',
      text: strip((sk.split('<div class="wiki-spec">')[0].match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ''),
      specializations: sk.split('<div class="wiki-spec">').slice(1).map(sp => {
        const h4 = (sp.match(/<h4>([\s\S]*?)<\/h4>/) || [])[1] || '';
        return {
          name: strip(h4.split('<span')[0]),
          max: (strip(h4).match(/max\s+([\d/]+)/) || [])[1] || '',
          text: strip((sp.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ''),
          modifiers: [...sp.matchAll(/<li><strong>([^<]*)<\/strong>\s*<span[^>]*>\(([^)]*)\)<\/span>\s*-?\s*([\s\S]*?)<\/li>/g)]
            .map(m => ({ name: strip(m[1]), max: (m[2].match(/max\s+([\d/]+)/) || [])[1] || '', text: strip(m[3]) })),
        };
      }),
    };
    return skill;
  });
  return { name: strip(summary.replace(/Melee|Ranged|Support/g, '')), role, rootPassive, skills };
});

const out = {
  source: `${URL_}/{bosses,passives}`,
  scraped: new Date().toISOString(),
  bossIntro: bossIntro.join('\n\n'),
  bosses,
  classes,
};
// A section that comes back empty means the markup moved, not that the game
// lost its bosses — write nothing rather than overwrite a good snapshot with
// zeros. That silent-zeros failure is exactly what left server/index.js's own
// wiki scrape pointed at a page with no classes on it for days.
const skills = classes.reduce((n, c) => n + c.skills.length, 0);
if (!bosses.length || !classes.length) {
  throw new Error(`wiki markup changed: ${bosses.length} bosses, ${classes.length} classes — snapshot left untouched`);
}
await writeFile(new URL('./wiki.html', import.meta.url), t);
await writeFile(new URL('./wiki.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`bosses: ${bosses.length}, classes: ${classes.length}, skills: ${skills}`);
// Per-skill prose stopped existing when the wiki switched to node graphs
// (2026-08-17). The structured node data now comes from parseWikiNodes in
// server/index.js, which feeds server/public/passives.json — not from here.
if (!skills) console.log('note: 0 skills is expected — the wiki renders node graphs now, see server/index.js parseWikiNodes');
