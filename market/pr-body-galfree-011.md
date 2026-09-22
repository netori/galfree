Point the entry's optional `tarball:` field at the `v0.1.1` release asset instead of the unversioned `latest/download` one.

## Why

Two reasons, one of them a real defect in the archive users are getting today.

**1. `v0.1.1` ships the plugin's agent preset.** The preset (`presets/galgame/`: a persona plus a guard row) is not something a storefront install would otherwise deliver — it lives in a directory beside the plugin, and its guard row's error message points at `presets/galgame/README.md`. In `0.1.0` that file was **not in the published archive at all** (the package's `files` list did not include `presets/`), so the pointer was dangling for everyone who installed. `0.1.1` adds `presets/` to `files`; the archive now carries `preset.yml`, `agent.cordis.yml`, `guard.mjs`, `README.md` (and the reference copy the plugin's own test compares against) next to `lib/`.

**2. It also publishes to npm.** `v0.1.1` is on the registry as `dsh-galfree@0.1.1`, so once the catalog's npm mapping is probed this entry will read as an npm package and the install command becomes `dsh plugin --profile web add dsh-galfree`. Until that probe happens, the `tarball:` field is what storefronts offer — hence this update.

## Why the URL form changed

`0.1.0` used `releases/latest/download/dsh-galfree.tgz` with a version-free asset name, which is the form contributing.md recommends for that spelling. This update pins the tag and uses the versioned filename instead — the other form contributing.md calls normal:

```yaml
tarball: https://github.com/netori/galfree/releases/download/v0.1.1/dsh-galfree-0.1.1.tgz
```

The pinned form was chosen here because it cannot silently change contents: a `latest/download` URL keeps working while the bytes behind it are replaced by a later release, so an entry that looks unchanged can start installing different code. A pinned tag plus a versioned filename makes what is offered auditable from the entry alone.

## Verifications

- `validateEntries()` on the whole catalog: 0 problems with this file in place.
- `tarballProblem()`: `https` + `github.com` + same owner/repo + `/releases/` + `.tgz`.
- The URL was fetched end to end (200, 342,527 bytes) and the downloaded bytes sha256-match the asset that was uploaded.
- The archive's contents were listed: `lib/index.js`, `lib/client.js`, `cordis.patch.yml`, and `presets/galgame/*`.
- `installTargetFor()` for this entry returns the `.tgz`; installing it into a fresh profile with a cold store and no `allowBuilds` entry completes in under a second with `lib/index.js` present.

Only this entry is touched.
