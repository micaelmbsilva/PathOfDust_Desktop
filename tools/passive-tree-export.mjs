// Export PathofDust's passive tree from the Rust source into machine-readable
// JSON — node keys, tier, parent, max rank, and the real per-rank magnitudes
// (`FlatStat` / `OverflowConversion` / `Special`), which the wiki only ever
// carries as prose. The advisor's tree layer reads the result; nothing here
// touches passives.json, which stays the wiki-scraped prose browser.
//
// Run: node tools/passive-tree-export.mjs [path/to/PathofDust]
//   -> writes solver/passive-tree.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || join(here, '..', '..', 'PathofDust'));
// The source tree was reorganized under game/ in Aug '26; keep the old path as
// a fallback for older checkouts.
const srcPath = [join(root, 'game', 'src', 'passive_tree.rs'), join(root, 'src', 'passive_tree.rs')]
  .find(existsSync);
if (!srcPath) throw new Error('passive_tree.rs not found under ' + root);
const src = readFileSync(srcPath, 'utf8');

// Strip whole-line `//` comments only — descriptions are ordinary string
// literals on the same line as their node, so a naive comment strip that
// scanned inside strings would eat them.
const decomment = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// Walk `text` from `i` (just past the opening paren) to its matching close,
// skipping over string literals and nested parens/braces.
function matchParen(text, i) {
  let depth = 1, inStr = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced call at ' + i);
}

// Split one call's argument list on top-level commas (same string/nesting rules).
function splitArgs(body) {
  const out = []; let start = 0, depth = 0, inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  const tail = body.slice(start).trim();
  if (tail) out.push(tail);
  return out.map((s) => s.trim());
}

const str = (a) => { const m = a.match(/^"([\s\S]*)"$/); return m ? m[1] : null; };
// `1.0 / 3.0` is the one arithmetic literal in the table (Titan's Grip).
const num = (a) => { const m = a.match(/^([\d.]+)\s*\/\s*([\d.]+)$/); return m ? +m[1] / +m[2] : +a; };

// Aug '26 rewrite qualifies the enum paths: `PassiveEffect::FlatStat { stat:
// PassiveStat::DamageReduction, .. }` where it used to be bare `FlatStat { stat:
// DamageReduction }`. Strip an optional `Path::` prefix off both the variant and
// the stat/input/output values so the output stays bare (the advisor's TREE_STAT
// keys on bare `DamageReduction`).
const bare = (a) => a.replace(/^\w+::/, '');
function parseEffect(expr) {
  const e0 = expr.trim();
  if (/^(?:\w+::)?NotYetImplemented$/.test(e0)) return { kind: 'none' };
  const m = e0.match(/^(?:\w+::)?(FlatStat|OverflowConversion|Special)\s*\{([\s\S]*)\}$/);
  if (!m) throw new Error('unparsed effect: ' + expr.slice(0, 80));
  const fields = {};
  for (const f of splitArgs(m[2])) {
    const [k, ...v] = f.split(':');
    fields[k.trim()] = v.join(':').trim();
  }
  const e = { kind: m[1][0].toLowerCase() + m[1].slice(1), r1: num(fields.at_rank_1), per: num(fields.per_additional_rank) };
  if (fields.stat) e.stat = bare(fields.stat);
  if (fields.input) { e.input = bare(fields.input); e.output = bare(fields.output); }
  return e;
}

const CALL = /\b(skill|spec|modifier|modifier_with_effect)\s*\(/g;
const out = {};
let total = 0, real = 0;

for (const m of src.matchAll(/static (\w+)_NODES: &\[PassiveNode\] = &\[/g)) {
  const start = m.index + m[0].length;
  const end = src.indexOf('\n];', start);
  const cls = m[1][0] + m[1].slice(1).toLowerCase();
  const body = decomment(src.slice(start, end));
  const nodes = [];
  CALL.lastIndex = 0;
  for (let c; (c = CALL.exec(body));) {
    const close = matchParen(body, CALL.lastIndex);
    const args = splitArgs(body.slice(CALL.lastIndex, close));
    CALL.lastIndex = close + 1;
    const fn = c[1];
    const isSkill = fn === 'skill';
    const [key, parent, name, description] = isSkill
      ? [str(args[0]), null, str(args[1]), str(args[2])]
      : [str(args[0]), str(args[1]), str(args[2]), str(args[3])];
    const effectExpr = fn === 'skill' ? args[3] : fn === 'spec' || fn === 'modifier_with_effect' ? args[4] : null;
    const effect = effectExpr ? parseEffect(effectExpr) : { kind: 'none' };
    nodes.push({
      key, name, description, parent,
      tier: isSkill ? 'skill' : fn === 'spec' ? 'spec' : 'modifier',
      // Skills/modifiers cap at 3; a spec's 4th point only unlocks its
      // children, it does not grow the spec's own stat (magnitude_at_rank).
      max: fn === 'spec' ? 4 : 3,
      magnitudeCap: fn === 'spec' ? 3 : 3,
      unlockAt: fn === 'modifier' || fn === 'modifier_with_effect' ? 4 : null,
      effect,
    });
    total++;
    if (effect.kind !== 'none') real++;
  }
  out[cls] = nodes;
}

// ---- Live overrides ---------------------------------------------------------
// The Rust source is no longer the last word on a node's numbers: the streamer
// can retune any node at runtime (passive_overrides.rs), and the running game
// uses the tuned value while the node's description prose keeps stating the old
// one. Scoring against the source alone was silently wrong by 2–5x on several
// nodes the advisor actually reads. The tuned triplet is published on the public
// wiki, so layer it on top here rather than shipping numbers the game doesn't use.
//
// Stored as an explicit `ranks` list, not r1/per: real overrides are frequently
// non-linear, and at least one is not monotonic, so no line fits them.
const WIKI = 'https://adventure.lokati.net/wiki/passives';
const wclean = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
let tunedCount = 0, tunedScraped = null;
try {
  const res = await fetch(WIKI);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = await res.text();
  for (let block of page.split(/<details class="[^"]*wiki-archetype[^"]*">/).slice(1)) {
    block = block.split('</details>')[0];
    const cls = wclean((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1])
      .replace(/Melee|Ranged|Support/g, '').replace(/[^A-Za-z ]/g, '').trim();
    if (!out[cls]) continue;
    for (const chunk of block.split('class="node ').slice(1)) {
      const head = chunk.slice(0, 1600);
      // "Tuned: A / B / C (default X / Y / Z)" — absent unless overridden.
      const note = (head.match(/passive-tuned[^>]*>Tuned:\s*([^<(]*)\(/) || [])[1];
      if (!note) continue;
      const ranks = note.trim().split('/').map((n) => +n.trim());
      if (ranks.length !== 3 || ranks.some((n) => !Number.isFinite(n))) continue;
      // The wiki is a read-only page with no node_key, so match on display name
      // within the class block — names are unique per class.
      const name = wclean((head.match(/class="node-name[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1])
        .replace(/\(inactive\)/i, '').trim();
      const node = out[cls].find((n) => n.name === name);
      if (!node) { console.warn(`tuned node not in the export: ${cls} / ${name}`); continue; }
      node.effect = { ...node.effect, ranks };
      tunedCount++;
    }
  }
  tunedScraped = new Date().toISOString();
} catch (err) {
  // Offline is survivable — the source values are still a correct baseline —
  // but it must be loud, because the result silently under-scores tuned nodes.
  console.warn(`WARNING: could not read live overrides from ${WIKI} (${err.message}).`);
  console.warn('         Wrote SOURCE magnitudes only; any retuned node is stale in this export.');
}

const json = {
  note: 'Generated by tools/passive-tree-export.mjs from PathofDust src/passive_tree.rs — do not hand-edit. '
    + 'magnitude(rank) = r1 + per * (min(rank, magnitudeCap) - 1), 0 at rank 0 — EXCEPT where `effect.ranks` is '
    + 'present, which is the streamer\'s live override (passive_overrides.rs) read off the public wiki and used '
    + 'verbatim per rank, because that is what the running game uses. '
    + 'kind "flatStat" adds to the tree layer of `stat`; "overflowConversion" converts combined gear+tree overflow of '
    + '`input` past its cap into `output` at that efficiency, hard-capped at 0.10 per invested rank; "special" is a '
    + 'bespoke mechanic read by key; "none" is allocatable but not yet implemented.',
  generatedFrom: 'src/passive_tree.rs',
  pointsForLevel: '1 + floor(level / 4)',
  overflowConversionCapPerRank: 0.10,
  counts: { nodes: total, withEffect: real, tuned: tunedCount },
  tunedScraped,
  tunedSource: WIKI,
  classes: out,
};
writeFileSync(join(here, '..', 'solver', 'passive-tree.json'), JSON.stringify(json, null, 1) + '\n');
console.log(`passive-tree.json: ${Object.keys(out).length} classes, ${total} nodes, ${real} with a real effect, ${tunedCount} live-tuned`);
