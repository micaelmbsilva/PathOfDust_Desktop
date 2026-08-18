// pre-commit: refuse a commit that ships a hot-updated file without advancing
// the interface revision.
//
// Why this exists: clients only re-fetch when version.json's revision RISES
// (main.cjs and server.mjs both compare it numerically). A page shipped without
// a bump reaches nobody, silently — that happened six times in the last thirty
// commits, twice in one afternoon.
//
// It FAILS rather than bumping for you. Several agent sessions share this
// working copy, and a hook that stages files can sweep another session's edits
// into your commit; it also behaves unpredictably under --amend, rebase and
// `git add -p`. Failing costs one command and can't corrupt anyone's work.
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gitOr = (fallback, ...args) => { try { return git(...args); } catch { return fallback; } };

// Read version.json from the INDEX, not the working tree: with partial staging
// (`git add -p`) the two differ, and the index is what's actually being committed.
const staged = JSON.parse(gitOr('null', 'show', ':version.json') || 'null');
if (!staged) process.exit(0); // no version.json in the index (fresh repo) — nothing to enforce

const changed = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n').filter(Boolean);
const shipped = changed.filter(f => (staged.files || []).includes(f));
if (!shipped.length) process.exit(0);

// Compare against what's PUBLISHED (origin/main), not HEAD. That is the number
// clients actually hold, and it makes amend/rebase and several local commits
// before one push all behave sensibly — one bump per push is what's needed.
const baseRef = gitOr('', 'rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'HEAD';
const base = JSON.parse(gitOr('{"version":0}', 'show', `${baseRef}:version.json`));

if (Number.isInteger(staged.version) && staged.version > base.version) process.exit(0);

console.error(`
✗ Interface revision not advanced.

  Staging ${shipped.length} hot-updated file(s): ${shipped.join(', ')}
  version.json revision is ${staged.version}, and ${baseRef} already has ${base.version}.

  Clients only re-fetch when this number RISES — commit as-is and this change
  reaches nobody.

  Fix:
      npm run bump && git add version.json

  Genuinely not a shippable change? Commit with --no-verify.
`);
process.exit(1);
