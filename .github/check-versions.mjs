// Asserts the release tag, package.json and package-lock.json all name the same
// version. electron-builder publishes to a GitHub release named after
// package.json, not after the tag, so a disagreement doesn't fail the build — it
// silently uploads into the WRONG release. v32.3.0 did exactly that: its
// artifacts went into v32.2.0 and no 32.3.0 release was ever created.
//
// Run: node .github/check-versions.mjs v32.2.1
import { readFile } from 'node:fs/promises';

const ref = process.argv[2] || '';
const read = async (f) => JSON.parse(await readFile(new URL(f, import.meta.url), 'utf8'));
const [pkg, lock] = await Promise.all([read('../package.json'), read('../package-lock.json')]);

const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };

if (!/^v\d+\.\d+\.\d+$/.test(ref)) fail(`tag "${ref}" is not vMAJOR.MINOR.PATCH`);
else if (ref.slice(1) !== pkg.version) fail(`tag ${ref} != package.json ${pkg.version}`);

// npm keeps the version in two places in the lockfile and both must move; only
// the top-level one is obvious, so the nested one is what silently rots (it sat
// two releases behind at 32.1.0).
if (lock.version !== pkg.version) fail(`package-lock.json version ${lock.version} != package.json ${pkg.version}`);
if (lock.packages?.['']?.version !== pkg.version)
  fail(`package-lock.json packages[""].version ${lock.packages?.['']?.version} != package.json ${pkg.version}`);

if (!process.exitCode) console.log(`✓ ${ref} == package.json == package-lock.json == ${pkg.version}`);
