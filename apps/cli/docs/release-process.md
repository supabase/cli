# Release Process

This document is the operational playbook for releasing the Supabase CLI TypeScript build. It covers three environments ("rings"):

1. **Ring 1 — Local Verdaccio.** Fastest feedback loop. Build and install the CLI from a local npm registry on your own machine. No network side-effects; no repo pushes.
2. **Ring 2 — User-owned PoC repos.** End-to-end validation through the exact same Homebrew / Scoop / GitHub-Release code paths production uses, but pointed at a reviewer's own GitHub account and a non-`supabase` artifact name. This is how ADR 0011 gates 2 and 3 are validated without risking the real production channels.
3. **Ring 3 — Production.** The real `supabase` npm package + `supabase/homebrew-tap` + `supabase/scoop-bucket` + GitHub Releases on `supabase/cli`. Driven by GitHub Actions (`release.yml`, which dispatches three channels — `alpha`, `beta`, `stable` — into the shared `release-shared.yml`).

```mermaid
flowchart LR
    local["Ring 1: Local Verdaccio<br/>pnpm cli-release<br/>--next or --legacy"]
    poc["Ring 2: User-owned PoC repos<br/>avallete/supabase-cli-release-poc<br/>avallete/homebrew-supabase-shim-poc<br/>avallete/scoop-bucket<br/>--name supabase-shim-poc"]
    prod["Ring 3: Production<br/>supabase/cli<br/>supabase/homebrew-tap<br/>supabase/scoop-bucket<br/>(default name: supabase)"]

    local --> poc --> prod
```

Move outward one ring at a time. Only promote to production after Ring 2 has exercised the full channel end-to-end on a fresh machine.

See [ADR 0011](../../../docs/adr/0011-cli-release-and-distribution-strategy.md) for the decision record behind this process (why Bun SFE, why npm `optionalDependencies`, why nfpm, why no hosted apt/rpm repo, why unsigned).

---

## Ring 1 — Local Verdaccio

Use this loop while iterating on build scripts, the Node shim, or anything that changes what gets packed into `supabase` or `@supabase/cli-<platform>`. It installs the CLI into a local npm registry and lets you `npx --registry http://localhost:4873 supabase` as if you'd installed from npm.

Start the registry in one terminal:

```sh
pnpm local-registry
```

Publish the CLI into it from another terminal (current platform only, faster than a cross-platform build):

```sh
# TS-native shell only ("next"):
pnpm cli-release --next

# Legacy shell (TS shim + Go sidecar — requires Go on PATH and `pnpm repos:install`):
pnpm cli-release --legacy
```

Test it:

```sh
npx --registry http://localhost:4873 supabase@<printed-version> --version
```

`[tools/release/local-release.ts](../../../tools/release/local-release.ts)` does the heavy lifting: it builds the platform SFE (+ Go binary for `--legacy`) and the umbrella `supabase` package, materialises them in a `tmp` dir (so no workspace `package.json` is modified), and publishes both to Verdaccio. The cleanup is automatic even on failure.

This is the right ring for:

- Debugging the Node shim (`[apps/cli/src/shared/cli/bin.ts](../src/shared/cli/bin.ts)`) — which platform package gets resolved, `execFileSync` behaviour.
- Reproducing a `supabase`-from-npm experience without touching any remote.
- Verifying `SUPABASE_CLI_VERSION` injection propagates to `--version` output.

It is **not** a valid test for Homebrew or Scoop — those paths are covered in Ring 2.

---

## Ring 2 — Testing uploads with user-owned repos

This is how you validate the Homebrew formula, Scoop manifest, and GitHub-Release-host resolution on real infrastructure without touching `supabase/`\* repos or risking a clash with an already-installed `supabase` CLI on the reviewer's machine.

Both updater scripts support a `--name <custom>` flag that pushes the formula / manifest under a different name (e.g., `supabase-shim-poc`) — that is, a different filename and Ruby class / scoop manifest. The installed binary is always `supabase` (matching the Go CLI), so PoC reviewers should `brew uninstall supabase` / `scoop uninstall supabase` first if they already have the official CLI installed.

### One-time setup (per reviewer)

Create three empty repos on your own GitHub account:

| Purpose                      | Repo name constraint                                                         | Example                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub Release artifact host | None                                                                         | `[avallete/supabase-cli-release-poc](https://github.com/avallete/supabase-cli-release-poc)`     |
| Homebrew tap                 | Must be named `homebrew-<anything>` (so `brew tap <owner>/<anything>` works) | `[avallete/homebrew-supabase-shim-poc](https://github.com/avallete/homebrew-supabase-shim-poc)` |
| Scoop bucket                 | None                                                                         | `[avallete/scoop-bucket](https://github.com/avallete/scoop-bucket)`                             |

All three can be empty git trees. The downstream updater scripts clone the Homebrew tap / Scoop bucket into a tmpdir with git, write their generated file, commit, and push.

Authenticate the GitHub CLI once with write access to all three:

```sh
gh auth login
gh auth status  # verify: ✓ Logged in to github.com account <you>
```

### Dry-run: generate artifacts without pushing

The `--dry-run` flag on both updater scripts produces the `Formula/<name>.rb` and `<name>.json` in `dist/` and prints them, without cloning or pushing to the tap/bucket. Good for inspecting changes before they go out.

```sh
# Build all eight platform archives + linux packages + checksums.txt.
# Shell = legacy (ship the Go sidecar alongside the Bun SFE); use --shell next
# once we're actually cutting over to the TS-native CLI.
bun apps/cli/scripts/build.ts --version 0.0.1 --shell legacy

# Render the Homebrew formula against your PoC release host + tap.
bun apps/cli/scripts/update-homebrew.ts --version 0.0.1 \
    --repo avallete/supabase-cli-release-poc \
    --tap avallete/homebrew-supabase-shim-poc \
    --name supabase-shim-poc \
    --dry-run

# Render the Scoop manifest against your PoC release host + bucket.
bun apps/cli/scripts/update-scoop.ts --version 0.0.1 \
    --repo avallete/supabase-cli-release-poc \
    --bucket avallete/scoop-bucket \
    --name supabase-shim-poc \
    --dry-run
```

Inspect `dist/supabase-shim-poc.rb` and `dist/supabase-shim-poc.json`. The `sha256` / `hash` fields resolve against `dist/checksums.txt`; the `url` fields point at `https://github.com/avallete/supabase-cli-release-poc/releases/download/v0.0.1/...` (the release host specified by `--repo`).

### Upload the GitHub Release

The updater scripts do **not** create the GitHub Release or upload `dist/`\* — in production that's `[release-shared.yml](../../../.github/workflows/release-shared.yml)`'s `publish` job. For a PoC run, do it manually with `gh release create`:

```sh
gh release create v0.0.1 \
    --repo avallete/supabase-cli-release-poc \
    --title "v0.0.1" \
    --notes "Ring 2 validation release" \
    dist/supabase_0.0.1_darwin_arm64.tar.gz \
    dist/supabase_0.0.1_darwin_amd64.tar.gz \
    dist/supabase_0.0.1_linux_arm64.tar.gz \
    dist/supabase_0.0.1_linux_amd64.tar.gz \
    dist/supabase_0.0.1_linux_arm64.deb \
    dist/supabase_0.0.1_linux_amd64.deb \
    dist/supabase_0.0.1_linux_arm64.rpm \
    dist/supabase_0.0.1_linux_amd64.rpm \
    dist/supabase_0.0.1_linux_arm64.apk \
    dist/supabase_0.0.1_linux_amd64.apk \
    dist/supabase_0.0.1_windows_amd64.zip \
    dist/supabase_0.0.1_windows_arm64.zip \
    dist/checksums.txt
```

### Push formula + manifest to PoC tap / bucket

Rerun the updater scripts without `--dry-run`. They clone the target repo into a tmpdir, write the new file, commit with message `<name> <version>`, and push.

```sh
bun apps/cli/scripts/update-homebrew.ts --version 0.0.1 \
    --repo avallete/supabase-cli-release-poc \
    --tap avallete/homebrew-supabase-shim-poc \
    --name supabase-shim-poc

bun apps/cli/scripts/update-scoop.ts --version 0.0.1 \
    --repo avallete/supabase-cli-release-poc \
    --bucket avallete/scoop-bucket \
    --name supabase-shim-poc
```

### User-side install commands

These are what a fresh reviewer would run — no repo clone required.

**macOS / Linux (Homebrew):**

```sh
brew uninstall supabase || true       # PoC formula installs a `supabase` binary too
brew tap avallete/supabase-shim-poc   # note: "avallete/<tap-suffix>", not the full repo name
brew install supabase-shim-poc
supabase --version                    # expect: supabase v0.0.1
brew test supabase-shim-poc           # expect: pass
```

The `brew tap <owner>/<suffix>` command looks up `https://github.com/<owner>/homebrew-<suffix>`. That's why the tap repo must be named `homebrew-supabase-shim-poc`, not just `supabase-shim-poc`.

**Windows (Scoop):**

```powershell
scoop uninstall supabase  # PoC manifest also shims `supabase.exe`
scoop bucket add avallete-poc https://github.com/avallete/scoop-bucket
scoop install supabase-shim-poc
supabase --version        # expect: supabase v0.0.1
```

Validated on Windows x64 (`v0.0.1`, 2026-04-21): installed with no SmartScreen block on the unsigned Bun SFE, `--version` output matched. Windows arm64 (Surface / Copilot+ / ARM VM) still pending — needs hardware or a Windows-on-ARM VM to exercise the `windows_arm64.zip` archive added by this branch.

### What to validate

Beyond `--version` and `brew test`, exercise a Phase-0 proxied subcommand that requires the `supabase-go` sidecar (`--shell legacy` only):

```sh
supabase completion bash
```

This must spawn the colocated `supabase-go` and print the generated completion script — not return `NotFound: ChildProcess.spawn (supabase ...)`. (`supabase --version` is served by the Bun wrapper and never touches the sidecar, so it is not a sufficient check on its own.) If it fails, the Homebrew install step is wrong: check that `[apps/cli/scripts/update-homebrew.ts](../scripts/update-homebrew.ts)`'s install-lines block ran `bin.install "supabase-go" if File.exist?("supabase-go")`, and that the built archive actually contains `supabase-go` (it should, for any `--shell legacy` build).

### Local-artifact testing (no GitHub Release upload)

Both updater scripts also support `--local`, which generates a formula/manifest pointing at `file://$PWD/dist/...` instead of a GitHub URL. Useful for a totally offline test:

```sh
bun apps/cli/scripts/update-homebrew.ts --version 0.0.1 \
    --name supabase-shim-poc --local --dry-run > /tmp/supabase-shim-poc.rb

brew install --build-from-source /tmp/supabase-shim-poc.rb
```

```powershell
bun apps/cli/scripts/update-scoop.ts --version 0.0.1 `
    --name supabase-shim-poc --local --dry-run
# Copy the JSON from dist/supabase-shim-poc.json, then:
scoop install .\dist\supabase-shim-poc.json
```

---

## Ring 3 — Production release flow

Production releases live in a single `[.github/workflows/release.yml](../../../.github/workflows/release.yml)` that dispatches three channels into the shared `[release-shared.yml](../../../.github/workflows/release-shared.yml)`:

| Channel | Trigger              | shell  | npm dist-tag | brew/scoop name | GH release | Version           |
| ------- | -------------------- | ------ | ------------ | --------------- | ---------- | ----------------- |
| alpha   | manual dispatch      | next   | alpha        | (skipped)       | prerelease | operator-supplied |
| beta    | push: develop        | legacy | beta         | supabase-beta   | prerelease | `X.Y.Z-beta.N`    |
| stable  | push: main (post-FF) | legacy | latest       | supabase        | latest     | `X.Y.Z`           |

`alpha` is reserved for the v3 rewrite (`next` shell), released only on demand. `beta` auto-publishes on every merge to `develop` (legacy shell). `stable` auto-publishes after a develop→main fast-forward, which itself happens when the weekly `[deploy.yml](../../../.github/workflows/deploy.yml)` cron PR is approved (the FF push to `main` re-fires `release.yml` via the `push: branches: [main]` trigger).

Beta + stable versions are computed by `cycjimmy/semantic-release-action` from conventional commits (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major). The `release` config lives in `apps/cli/package.json` and is configured with `prerelease: beta` on the `develop` branch, so develop pushes emit `X.Y.Z-beta.N` and main pushes emit `X.Y.Z` (suffix dropped).

```mermaid
flowchart TD
    pushDev[push: develop] --> plan
    pushMain[push: main] --> plan
    pr[PR develop→main approved] --> ff[fast-forward job<br/>git push origin main via App token]
    ff --> pushMain
    dispatch[workflow_dispatch<br/>channel + version] --> plan

    plan["plan (ubuntu-latest)<br/>cycjimmy/semantic-release-action --dry-run<br/>computes channel, version, shell, npm_tag, brew/scoop name"]
    plan --> shared

    shared["release-shared.yml"]
    shared --> build["build<br/>sync-versions, build.ts, nfpm<br/>upload-artifact"]
    build --> smoke["smoke-test matrix<br/>ubuntu-latest, macos-latest,<br/>macos-15-intel, windows-latest"]
    smoke --> pub["publish<br/>id-token: write (OIDC trusted publishing)<br/>bun publish --provenance × 8 platform pkgs<br/>then bun publish --provenance umbrella supabase"]
    pub --> rel["softprops/action-gh-release<br/>(draft) → gh release edit --draft=false"]
    rel --> hb["publish-homebrew<br/>App-token-authed clone of homebrew-tap<br/>update-homebrew.ts --name <brew_name>"]
    rel --> sc["publish-scoop<br/>App-token-authed clone of scoop-bucket<br/>update-scoop.ts --name <scoop_name>"]
    rel --> sucs["setup-cli-smoke<br/>install via supabase/setup-cli<br/>(GitHub Release download)"]
    hb --> vic["verify-install-channels<br/>real brew/scoop/install-script installs<br/>against the live channels"]
    sc --> vic
```

### Trigger

Most releases are automatic — merge a PR into `develop` (beta) or approve the weekly Prod-Deploy PR into `main` (stable). Hotfixes use the same production gate: a reviewed `hotfix/*` PR targets `main`, and the resulting `main` push triggers the stable release path. For an `alpha` cut or a one-off override, dispatch manually:

```sh
# Manual alpha cut (v3 / next shell):
gh workflow run release.yml \
    --field channel=alpha \
    --field version=3.0.0-alpha.1 \
    --field dry_run=true   # set false for the real run

# Manual beta or stable override (operator-supplied version):
gh workflow run release.yml \
    --field channel=beta \
    --field version=0.0.0-beta.99 \
    --field dry_run=true
```

Auto-trigger paths leave `version` empty: semantic-release computes it from commits since the last tag.

### Hotfix release flow

Use a hotfix when an urgent stable fix must ship before the next scheduled `develop` -> `main` promotion. The hotfix path deliberately reuses the production PR gate instead of adding a second approval mechanism:

1. Branch from the current `main` tip:

   ```sh
   git fetch origin main
   git switch -c hotfix/<short-description> origin/main
   ```

2. Make the smallest safe fix and open a PR from `hotfix/<short-description>` into `main`.
3. Before merging, run a release dry run against the hotfix branch and the next unique stable version:

   ```sh
   gh workflow run release.yml \
       --ref hotfix/<short-description> \
       --field channel=stable \
       --field version=<next-patch-version> \
       --field dry_run=true
   ```

4. After review and green checks, merge the hotfix PR into `main`. The `push: main` trigger runs the normal stable release pipeline and publishes the next semantic-release version.
5. Watch the stable release workflow through publish, Homebrew/Scoop updates, and verification.
6. Confirm that `Sync main to develop` succeeds. That workflow merges `main` back into `develop` after a successful `Release` run on `main`, keeping the hotfix reachable from the next beta and the next scheduled production deploy. If the sync conflicts, resolve it with a follow-up PR into `develop` before the next production promotion.

Do not use `workflow_dispatch dry_run=false` as the normal hotfix path. Manual stable dispatch is reserved for re-cutting a unique version after an interrupted or stale-bytes release. Hotfixes should land through a PR to `main` so the production source of truth and release tag history stay aligned.

### What each job does

`**build` (ubuntu-latest):\*\*

1. `[pnpm exec bun apps/cli/scripts/sync-versions.ts --version X.Y.Z](../scripts/sync-versions.ts)` — writes the release version into every `package.json` (umbrella + eight platform packages) and resolves the umbrella's `workspace:`\* `optionalDependencies` to `X.Y.Z`.
2. `[pnpm exec bun apps/cli/scripts/build.ts --version X.Y.Z --shell <legacy|next>](../scripts/build.ts)` — cross-compiles the Bun SFE for all eight targets (including windows-arm64), cross-compiles the Go sidecar (`--shell legacy` only), **ad-hoc signs the macOS binaries** (see [Code signing (macOS)](#code-signing-macos)), builds the six Linux packages via `nfpm`, produces the tar/zip archives, and writes `dist/checksums.txt`.
3. `actions/upload-artifact` preserves `packages/cli-*/bin/` and `dist/` for the downstream jobs.

`**smoke-test` (matrix: `ubuntu-latest`, `macos-latest`, `macos-15-intel`, `windows-latest`):\*\*

Downloads the build artifact, makes the SFE executable (`chmod +x` on non-Windows), installs Scoop on Windows, and runs `pnpm run test:smoke -- --version X.Y.Z --tag <latest|beta|alpha>` from `apps/cli`. On the macOS legs this also verifies each binary's signature (`codesign --verify --strict`, correct identifier, not linker-signed) and executes `supabase --version`, which is the real AMFI gate. Any failure blocks publishing.

The matrix does not yet include `windows-11-arm` (gate 6) or an Alpine musl runner (also gate 6). Until those land, arm64 / musl regressions only surface in Ring 2 validation.

`**publish` (ubuntu-latest, `if: !inputs.dry_run`):\*\*

1. Re-runs `sync-versions.ts` (download-artifact restores file modes but not JSON mutations).
2. `[pnpm exec bun apps/cli/scripts/publish.ts --tag <latest|beta|alpha>](../scripts/publish.ts)` — publishes the eight platform packages in parallel via OIDC trusted publishing (`bun publish --provenance`, no `NPM_TOKEN`), then the umbrella package last so `optionalDependencies` resolve cleanly at install time.
3. `softprops/action-gh-release` creates a **draft** Release `v<version>` on `supabase/cli` with all tar / zip / deb / rpm / apk + `checksums.txt`.
4. `gh release edit v<version> --draft=false` finalises it (immutable from this point).

### Post-publish: Homebrew + Scoop

Both updaters run automatically from `release-shared.yml`'s `publish-homebrew` and `publish-scoop` jobs after the GitHub Release is finalised. Each job mints a GitHub App token scoped to `homebrew-tap` / `scoop-bucket` (via `actions/create-github-app-token` with the `GH_APP_CLIENT_ID` + `GH_APP_PRIVATE_KEY` secrets), runs `gh auth setup-git` + sets a `github-actions[bot]` git identity, then invokes `apps/cli/scripts/update-homebrew.ts` / `update-scoop.ts` with `--name <brew_name>` / `--name <scoop_name>`:

- `stable` → `--name supabase` (the default formula / manifest, what `brew install supabase` resolves)
- `beta` → `--name supabase-beta` (a separate formula / manifest for the prerelease channel)
- `alpha` → skipped (Homebrew + Scoop are not part of the v3 alpha story; npm only)

### Post-publish: install-channel verification

Once the channels are live, two reusable workflows run automatically (last in `release-shared.yml`, non-gating — by the time they run the artifacts are already published, so a failure surfaces as a red post-release signal rather than blocking distribution):

- `[setup-cli-smoke-test.yml](../../../.github/workflows/setup-cli-smoke-test.yml)` (`setup-cli-smoke` job) — installs the released version through `supabase/setup-cli` (the GitHub Release download path) on Linux, macOS, Windows, and Alpine.
- `[verify-install-channels.yml](../../../.github/workflows/verify-install-channels.yml)` (`verify-install-channels` job) — runs a **real** `brew install` (macOS **and** Linux, so both the `on_macos` and `on_linux` stanzas of the formula are exercised), `scoop install`, and `curl|bash` install of the **published** install script (fetched from the release asset, not the repo checkout) against the just-published Homebrew tap, Scoop bucket, and GitHub Release. Each leg then asserts `supabase --version` matches and runs `supabase completion bash` (a Go-proxied command) so a package that omits or misplaces the `supabase-go` sidecar fails too. brew, scoop, and the install script each verify the published `sha256`/`hash` against the downloaded tarball, so this is the signal that would have caught CLI v2.107.0 (where the brew/scoop manifests shipped checksums that did not match the release tarballs and every `brew install` / `scoop install` failed). It only runs for `beta`/`stable` (the channels that publish brew/scoop) and can be dispatched manually against any already-published version via the Actions tab.

### Code signing (macOS)

The macOS binaries (`supabase` Bun SFE + `supabase-go` sidecar, `darwin-arm64` and `darwin-x64`) are signed inside `build.ts` between compilation and archiving, so the signed bytes flow into every channel that consumes `packages/cli-darwin-*/bin/` — npm platform packages, Homebrew, and the GitHub Release tarballs (which also feed the `install` script and `setup-cli`). Background: [ADR 0014](../../../docs/adr/0014-macos-code-signing-and-notarization.md).

Why this exists: `bun build --compile` and the Go linker emit only a degenerate "linker-signed" ad-hoc signature (identifier `a.out`, no requirements blob). macOS 26+ AMFI rejects it and SIGKILLs the process at launch ([CLI-1621](https://linear.app/supabase/issue/CLI-1621) / [#5556](https://github.com/supabase/cli/issues/5556)). A full ad-hoc signature fixes it.

- **Signing runs on the Linux build runner** via [`rcodesign`](https://github.com/indygreg/apple-platform-rs) (the apple-codesign project), which signs Mach-O binaries without a macOS host. No macOS signing job exists, and **no Apple credentials are required for the current ad-hoc signing** (Phase 1). The version + sha256 are pinned in the "Install rcodesign" step of [`build-cli-artifacts.yml`](../../../.github/workflows/build-cli-artifacts.yml).
- **CI hard-fails if signing is unavailable**: the build job sets `SUPABASE_CLI_REQUIRE_SIGNING=1`, so a missing `rcodesign` fails the build rather than silently shipping unsigned binaries. Local builds without `rcodesign` degrade to a warning and skip signing.
- **Validation gate (required before every production cut):** signing is produced on Linux, so it must be _proven_ on a real Mac before publishing. This is automatic — `publish` has `needs: smoke-test` and the macOS smoke legs (`macos-latest`, `macos-15-intel`) both check the signature and run the binary; a bad signature fails smoke-test and blocks publish. **Before relying on a release, dispatch a staged dry run and confirm the macOS smoke legs are green:**

  ```sh
  gh workflow run release.yml --field channel=beta --field version=0.0.0-beta.99 --field dry_run=true
  # Watch the run; the macOS smoke-test legs must pass. `dry_run=true` runs build + smoke
  # (signature verification + `supabase --version`) but skips publish.
  ```

  This is the gate that catches any divergence between an `rcodesign`-produced ad-hoc signature and what macOS AMFI accepts. Do not promote a real (`dry_run=false`) release until a dry run on the same commit has shown the macOS smoke legs green.

> **Phase 2 (Developer ID + notarization)** is not yet enabled. It only matters for the _direct-download_ path (a quarantined `.tar.gz`/`.zip` from the GitHub Release), not for Homebrew/npm/Scoop. It will be added behind Apple credential secrets — see [ADR 0014](../../../docs/adr/0014-macos-code-signing-and-notarization.md).

### Verification

The `verify-install-channels` workflow above automates the manual checks below for the brew/scoop/install-script channels; the steps remain useful for a manual sanity check or for the npm/provenance bits the workflow does not cover. After `release-shared.yml` finishes (all jobs including `publish-homebrew` and `publish-scoop`):

```sh
npm view supabase@0.1.0 dist-tags   # expect: latest: 0.1.0 (or beta: 0.1.0-beta.N for beta channel)
gh release view v0.1.0 --repo supabase/cli

# macOS / Linux:
brew update && brew upgrade supabase   # or: brew install supabase-beta
supabase --version   # expect: supabase v0.1.0

# Windows:
scoop update
scoop install supabase                 # or: scoop install supabase-beta
supabase --version   # expect: supabase v0.1.0
```

The npm package page should also show **Provenance** linking back to `supabase/cli` + `release.yml` (OIDC-attested build).

### Rollback

The per-channel artifacts are immutable once published, so rollback = point users at the previous good version:

1. **npm:** `npm dist-tag add supabase@<prev-good-version> latest`. The broken version stays installable but loses the `latest` tag.
2. **GitHub Release:** `gh release delete v<broken-version> --repo supabase/cli` (or mark it `prerelease: true` via `gh release edit` to keep the tag around). Artifacts remain downloadable unless the release itself is deleted.
3. **Homebrew:** in `supabase/homebrew-tap`, `git revert <commit that wrote Formula/supabase.rb for broken version>` + push. `brew update` picks it up.
4. **Scoop:** same pattern in `supabase/scoop-bucket` — `git revert` the manifest commit.

Rollback is straightforward because each channel is its own commit / release. There's no cross-channel state to reconcile.

---

## See Also

- [ADR 0011](../../../docs/adr/0011-cli-release-and-distribution-strategy.md) — the decision record. Channel choices, signing rationale, open pre-cutover gates.
- `[apps/cli/docs/binary-distribution.md](./binary-distribution.md)` — why each platform package contains two binaries (`supabase` SFE + `supabase-go` sidecar) and how they're resolved at runtime.
- `[tools/release/local-release.ts](../../../tools/release/local-release.ts)` — Ring 1 implementation.
- `[apps/cli/scripts/build.ts](../scripts/build.ts)`, `[publish.ts](../scripts/publish.ts)`, `[sync-versions.ts](../scripts/sync-versions.ts)`, `[update-homebrew.ts](../scripts/update-homebrew.ts)`, `[update-scoop.ts](../scripts/update-scoop.ts)` — release script implementations.
- `[.github/workflows/release.yml](../../../.github/workflows/release.yml)`, `[release-shared.yml](../../../.github/workflows/release-shared.yml)`, `[deploy.yml](../../../.github/workflows/deploy.yml)`, `[deploy-check.yml](../../../.github/workflows/deploy-check.yml)` — Ring 3 pipeline.
