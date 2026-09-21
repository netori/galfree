Adds the optional `tarball:` field to `data/plugins/netori__galfree.yml` so storefronts offer the prebuilt release archive instead of the build-from-source command.

## Why

The entry currently resolves to `github:netori/galfree`. This repository carries no build output — `lib/` is `.gitignore`d and `package.json`'s `prepare` script builds it on install. On a **cold pnpm store** that path fails with:

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from
"https://codeload.github.com/netori/galfree/tar.gz/<commit>": The git-hosted package
"dsh-galfree@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.
```

Users then have to add a commit-pinned `allowBuilds` key by hand, and the key changes on every push to `main`. It reproduces on the pnpm that DSH Desktop bundles (11.8.0) and only clears once a build has landed in the local store. This is the "repo can't be installed from source cleanly" case contributing.md describes, so the prebuilt tarball is the right fix rather than a convenience.

## What

`v0.1.0` publishes a prebuilt archive as a release asset: `lib/index.js` (host half), `lib/client.js` (panel half) and `cordis.patch.yml`.

```
https://github.com/netori/galfree/releases/latest/download/dsh-galfree.tgz
```

The asset name carries no version, so `latest/download` cannot rot on the next release.

## Verifications

- `sh scripts/check-submission.mjs`-style gates, checked by hand against the live repo: `package.json` declares `dsh.bundle.patch = ./cordis.patch.yml`; the repo is public, not archived, not a fork, carries the `dsh-plugin` topic, and is 9.9 days old (bar: 1). No `npm:` key in the entry.
- `validateEntries()` from `scripts/lib/entries.mjs` reports 0 problems for the whole catalog with this file in place.
- `tarballProblem()` passes: `https` + `github.com` + same owner/repo + `/releases/` + `.tgz`.
- The URL was fetched end to end; the downloaded bytes sha256-match the uploaded asset.
- `installTargetFor()` for this entry returns the `.tgz`. Installing that archive into a fresh profile with a **cold store and no `allowBuilds` entry** succeeds in **768 ms** with `lib/index.js` present and the host half importing against the harness packages — no build step runs.

No other entry is touched.
