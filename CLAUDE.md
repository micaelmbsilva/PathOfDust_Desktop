# Working conventions

Written after an afternoon where several correct changes shipped to nobody. Every
rule here exists because its absence caused a real failure, not because it sounded
tidy.

## The three version numbers

| number | lives in | controls | enforced by |
|---|---|---|---|
| interface revision | `version.json` `version` (integer) | whether running clients re-fetch the web UI | `.githooks/pre-commit` |
| app version | `package.json` `version` (semver) | what electron-builder names the GitHub release | CI `verify` job |
| release tag | `git tag vX.Y.Z` | what triggers the release workflow | CI `verify` job |
| UI display version | `version.json` `display` (semver string) | the "UI x.y.z" the user sees | nothing — bump by hand |

### Versioning is plain SemVer (repo-wide rule, as of 4.0.0)

App version, tag and `display` are plain SemVer, shown to the user as-is except
that **trailing zero components are hidden**: `4.0.0` reads "v4", `4.1.0` reads
"v4.1", `4.1.2` reads "v4.1.2" (client-side `fmtV` in `index.html` is the only
formatter — never add a second). The old digit-folding (`32.4.0` shown as
"3.2.4") is gone; do not reintroduce derived display math. "ALPHA" is a
display-only label in `index.html` — it never goes into the semver, the tag, or
`package.json` (a prerelease suffix would move electron-updater onto a
different channel and fail the CI tag regex).

`display` is bumped **by hand, only when the UI meaningfully changes** — it is
independent of the interface revision, which keeps auto-bumping on every
shipped change. Be mindful when bumping: all the numbers in this table must
agree with each other per their own rules before tagging.

**History note:** 4.0.0 was a deliberate renumber *down* from 32.4.0.
electron-updater refuses downgrades, so shells installed at 32.x never see
shell updates again (UI hot-pull still works there); never renumber downward
again.

**The tag does not name the release — `package.json` does.** electron-builder
uploads to a release named after `package.json`, so a tag that disagrees silently
publishes into the *other* version's release. `v32.3.0` did this: its artifacts
landed in the `v32.2.0` release and no 32.3.0 was ever created. `.github/check-versions.mjs`
now blocks that, and also checks `package-lock.json`, whose two version fields sat
two releases behind before anyone noticed.

To ship an installer:

```bash
npm version <x.y.z> --no-git-tag-version   # updates package.json AND the lockfile
git commit -am "..." && git tag v<x.y.z> && git push origin main --tags
```

### The interface revision is an integer, and must stay one

It is compared **numerically by two independent implementations** — the launch
pull in `main.cjs` and the periodic pull in `server.mjs` — and `autoreload.js`
hard-gates on `typeof v.ui === 'number'`. Making it a semver string breaks all
three: `"1.10.0" <= "1.9.0"` is true under string comparison, so updates would
stop dead at 1.10.0, and page auto-reload would switch off entirely.

Bump it with `npm run bump`, which **parses the JSON**. Never `sed`. A
`sed 's/153/154/'` silently matches nothing when a concurrent session has already
moved the number — that is precisely how a change shipped against a stale
revision and reached no client.

## Concurrency: several agent sessions share this working copy

This is the root cause behind more than one of the above.

- **Stage explicit paths. Never `git add -A`.** It swept three unrelated files
  from another session into an unrelated commit.
- **Prefer a separate worktree per session.** Shared-index mutation is the real
  hazard; the rules above are mitigations for it.
- Re-read state before acting on it. Version numbers moved twice *during* an audit
  of those very numbers.

## External source

`D:\DEV\POD\PathofDust` is the Rust game source: **read-only reference**. Read it
to confirm real behavior (e.g. `adventure_web.rs` clamps craft `times` to `1..=50`,
which is where the ×50 batch cap comes from). Never edit it.

## Tests

```bash
npm test        # advisor-core.test.mjs + scrape.test.mjs + codec.test.mjs
```

Both run in CI's `verify` job before anything publishes.

## Hooks

```bash
git config core.hooksPath .githooks   # one-time, per clone
```

`pre-commit` refuses a commit that changes a file listed in `version.json.files`
without advancing the revision. It **fails rather than bumping for you** — a hook
that stages files can sweep a concurrent session's edits into your commit, and
misbehaves under `--amend`, rebase and `git add -p`. It reads the *index*, not the
working tree, so partial staging is handled correctly. `--no-verify` escapes it.
