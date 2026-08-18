// Advance the interface revision in version.json.
//
// Parses the JSON — never a text match. A `sed 's/153/154/'` silently no-ops
// when a concurrent session has already moved the number, which is exactly how
// a change shipped against a stale revision this afternoon: the sed matched
// nothing, the commit looked fine, and no client ever pulled it.
//
// Run: npm run bump
import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../version.json', import.meta.url);
const man = JSON.parse(await readFile(path, 'utf8'));

if (!Number.isInteger(man.version)) {
  console.error(`✗ version is ${JSON.stringify(man.version)}, expected an integer — refusing to guess.`);
  process.exit(1);
}

man.version += 1;
// Single-line, matching how both pullers write it back after an update.
await writeFile(path, JSON.stringify(man));
console.log(`✓ interface revision -> ${man.version}`);
