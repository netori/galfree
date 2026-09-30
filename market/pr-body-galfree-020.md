Point the entry's optional `tarball:` field at the `v0.2.0` release asset.

## Why

`v0.1.2` — what this field points at today — **cannot load on the harness users are running now.** Its published metadata declares:

```json
"peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.1.5-0 <0.2.0-0" }
```

The harness gates every plugin bundle on its `@deepseek-ai/dsh*` peer ranges: each range is evaluated against the runtime version, and **one unsatisfied range disables the entire entry**. `0.2.0-rc.2` falls outside that range, so on a 0.2.x host the package installs, the profile's config row for it is present, and then nothing runs — no agent tools, no `/api/galfree/*` routes, no web panel, no "skipping" line the user would recognise as the cause.

`0.2.0` widens the upper bound to `<0.3.0-0`:

```json
"peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.1.5-0 <0.3.0-0" }
```

The entry has carried the same caveat since 0.1.0 and it has not changed: no static range covers every prerelease tuple, because node-semver only admits prereleases whose tuple is named by a comparator (so `0.2.0-rc.2` needs a comparator carrying `0.2.0`). The harness's own gate evaluates with `includePrerelease: true`, which is what makes `<0.3.0-0` admit `0.2.0-rc.2` — and, more to the point, that is not an argument from the semver spec but from a boot: on a real `0.2.0-rc.2` host the plugin row mounts, `/api/galfree/state` answers `200`, and the client bundle is served.

The release also lands three things that were user-reported defects:

- **The stage layer.** Modern Ren'Py no longer defines image names automatically, so `scene bg ferry` fell back to a grey placeholder and `show <character> <expression>` raised `Image does not accept attributes`, taking the game down; two sprites with no placement data also drew on top of each other. A generated `game/zz_galfree_stage.rpy` now carries explicit `image` definitions and `at` placement clauses (only for `gf_`-prefixed names — hand-written `at left` and custom transforms are never touched).
- **Performance text colors**, restricted to scenes marked `# galfree:perf`, with a per-scene budget (one colour deviation per 20 dialogue lines, at most two colours, at most one fully-coloured line) and ≥ 4.5:1 contrast against the outline colour.
- **`config.auto_voice` is now written as a callable**, because the container is not ours to choose: Xiaomi MiMo TTS only emits `wav/mp3/pcm` (asking it for ogg is refused with `Unsupported audio format: ogg`), while a local IndexTTS emits ogg. A string form pins one extension, and pinning the wrong one fails silently — the engine raises nothing, a playtest still passes, and the lines simply have no voice.

## Why this file, given the entry already installs from npm

The entry carries an auto-collected `npm: dsh-galfree` mapping, and `installTargetFor()` prefers npm over `tarball:`, so storefront installs already resolve from the registry (`latest` moves when a version is published; market installs also pass `--config.minimum-release-age=0`, so the fresh-release hold cannot substitute the previous version). This change is about the **fallback staying honest**: the field is what a reader — or a client that has not applied the npm mapping — is offered, and leaving it on a build that cannot load would make the entry's own link the least useful thing on it.

## Verifications

- Entry re-checked with the plugin repo's own mirror of the CI rules (`scripts/check-market-entry.mjs`): shape and `tarballProblem()` both pass — `https` + `github.com` + same owner/repo + `/releases/` + `.tgz`.
- The asset was built and measured before this PR: `npm pack` → `dsh-galfree-0.2.0.tgz`, **391,765 bytes**, 13 files (`lib/index.js`, `lib/client.js`, `cordis.patch.yml`, `presets/galgame/*`, `docs/contracts/*`).
- The peer-range claim above was re-read from the registry rather than from the repo: `npm view dsh-galfree@0.1.2 peerDependencies` → `>=0.1.5-0 <0.2.0-0`, and `semver.satisfies('0.2.0-rc.2', thatRange)` is `false`.
- Gate: `typecheck` clean, full suite 59 files / 640 tests passing, tree clean at the release commit.
- The scheme is unchanged: pinned tag plus versioned filename, the form contributing.md calls normal, and the form this field already used. No `latest/download`.

Only this entry is touched.
