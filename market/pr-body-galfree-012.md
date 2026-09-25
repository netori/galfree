Point the entry's optional `tarball:` field at the `v0.1.2` release asset.

## Why

`v0.1.1` — what this field points at today — **cannot load on the harness the users are running now.** Harness `0.1.7` replaced the plugin settings model outright, and `0.1.1` dies on the first statement of its `apply()`:

- `ctx.settings.register(namespace, schema, { base })` **no longer exists**. `ctx.settings` is now `SettingsForms`, whose surface is `configure/describe/update/replace/mutate/write/schema`.
- On the client half, `settingsScope` and the `settings.plugin.item` / `settings.section` slots are gone from the shipping bundle — zero occurrences.

The failure mode is the bad one: the package installs cleanly, then the plugin's fiber fails to activate, so its **agent tools, its `/api/galfree/*` routes and its web panel all go missing together**. Nothing tells the user why.

`0.1.2` migrates both halves to the current contract — host config as `.volatile()` references read through `.get()`, client writes through `ctx.configForms`, its settings page registered into the Plugins page's `plugins.bundle.config` — and pins `@deepseek-ai/schemastery` as the schema library the harness actually validates `Config` with. It was booted in a real `0.1.7-rc.2` host: the plugin row mounts, `/api/galfree/{state,progress,cast,theme,sdk}` all answer `200`, the client bundle is served, the settings namespace is served with all 16 fields, and a settings write round-trips. The agent preset that ships in the archive was moved onto `0.1.7`'s preset format as well (`0.1.7` deleted the `$DSH_HOME/.agent-presets/<id>/` directory mechanism, so that half of `0.1.1` was silently dead too).

`0.1.2` requires harness **≥ 0.1.7**.

## Why this file, given the entry already installs from npm

The entry carries an auto-collected `npm: dsh-galfree` mapping (`install: dsh plugin --profile web add dsh-galfree`), and `installTargetFor()` prefers npm over `tarball:` — so storefront installs already resolve `0.1.2` from the registry (`latest` moved to `0.1.2` when it was published; market installs also pass `--config.minimum-release-age=0`, so the fresh-release hold can't substitute `0.1.1`). This change is about the **fallback staying honest** rather than the primary path: the field is what a reader — or a client that has not applied the npm mapping — is offered, and leaving it on a build that cannot load would make the entry's own link the least useful thing on it.

## Verifications

- Entry re-checked with the plugin repo's own mirror of the CI rules (`scripts/check-market-entry.mjs`): shape and `tarballProblem()` both pass — `https` + `github.com` + same owner/repo + `/releases/` + `.tgz`.
- The URL was fetched end to end: `200`, 351,100 bytes.
- `npm pack --dry-run` on the release commit lists `lib/index.js`, `lib/client.js`, `cordis.patch.yml` and `presets/galgame/*` (13 files) — the archive carries everything the entry implies.
- A cold-store install of the published `dsh-galfree@0.1.2` from the registry completes and lands with `lib/` and the preset present.
- The scheme is unchanged: pinned tag plus versioned filename, the form contributing.md calls normal, and the form this field already used. No `latest/download`.

Only this entry is touched.
