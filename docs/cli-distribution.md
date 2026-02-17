# CLI Packaging, Distribution & Smoke Tests

## Architecture

The Supabase CLI ships as a compiled Bun binary (`supabase`) that proxies all commands to a sidecar Go binary (`supabase-backend`). Both binaries live in the same directory:

```
bin/
  supabase          # compiled Bun binary (entrypoint)
  supabase-backend  # Go binary (engine)
```

The Bun binary uses `spawnSync` with `stdio: "inherit"` to forward all arguments, exit codes, and signals to the Go backend. It locates the sidecar via `path.dirname(process.execPath)`.

## Build Process

A single build script (`packages/cli-dist/scripts/build.ts`) produces all artifacts from one machine (Ubuntu in CI). It takes two arguments:

- `--go-version` — the supabase/cli release to wrap (e.g. `2.75.0`)
- `--version` — the version to stamp on packages

For each of the 5 targets (darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64):

1. Cross-compiles the Bun CLI via `bun build --compile --target=<target>`
2. Downloads the matching Go CLI binary from GitHub releases
3. Places both in the platform package's `bin/` directory

It then:

4. Builds musl variants of the Bun CLI for Alpine Linux (arm64 + x64)
5. Creates distributable archives in `dist/` (tar.gz for Unix, zip for Windows)
6. Generates Linux packages (.deb, .rpm, .apk) via nfpm
7. Writes `dist/checksums.txt` with SHA256 hashes for all artifacts

Alpine apk packages use the musl-compiled Bun binary and declare `libstdc++` and `libgcc` as dependencies.

## Distribution Channels

### npm

Uses the platform-specific `optionalDependencies` pattern (same as esbuild):

- **Platform packages** — `@supabase/cli-darwin-arm64`, `@supabase/cli-darwin-x64`, `@supabase/cli-linux-arm64`, `@supabase/cli-linux-x64`, `@supabase/cli-windows-x64`. Each declares `os` and `cpu` fields so npm only installs the matching one.
- **Umbrella package** — `@supabase/cli` lists all platform packages as `optionalDependencies` and includes a Node.js ESM bin shim (`bin/supabase.js`, built from `src/bin.ts` via `bun build --target node`) that resolves the correct platform binary via `createRequire` + `require.resolve`.

Published by `packages/cli-dist/scripts/publish.ts` using `bun publish`: platform packages first (in parallel), then the umbrella package. Supports `--dry-run`.

### Homebrew

`packages/cli-dist/scripts/update-homebrew.ts` generates a formula (`dist/supabase.rb`) from the checksums file. The formula installs both `supabase` and `supabase-backend`.

In production, it clones the `supabase/homebrew-tap` repo, updates `Formula/supabase.rb`, commits, and pushes. With `--local`, it writes the formula with `file://` URLs for local testing.

### Scoop

`packages/cli-dist/scripts/update-scoop.ts` generates a manifest (`dist/supabase.json`) with the Windows amd64 zip URL and hash.

In production, it pushes to `supabase/scoop-bucket`. With `--local`, it writes the manifest with `file:///` URLs for local testing.

### GitHub Releases

The release workflow creates a GitHub release with these artifacts:

- `supabase_darwin_arm64.tar.gz`, `supabase_darwin_amd64.tar.gz`
- `supabase_linux_arm64.tar.gz`, `supabase_linux_amd64.tar.gz`
- `supabase_linux_{arm64,amd64}.{deb,rpm,apk}`
- `supabase_windows_amd64.zip`
- `checksums.txt`

## Smoke Tests

`packages/cli-dist/scripts/smoke-test.ts` verifies that every artifact installs and runs correctly. Tests run in parallel and check that `supabase --version` outputs a valid semver string.

### Docker-based Linux tests

Run on any machine with Docker (multi-arch via `--platform`):

| Test | Image | Method |
|------|-------|--------|
| `linux-{arch}-tarball` | `debian:bookworm-slim` | `tar -xzf` + run |
| `linux-{arch}-deb` | `debian:bookworm-slim` | `dpkg -i` + run |
| `linux-{arch}-rpm` | `amazonlinux:2023` | `rpm -ivh` + run |
| `linux-{arch}-apk` | `alpine:3.21` | `apk add --allow-untrusted` + run |

Each test runs for both arm64 and amd64 (8 tests total).

### Native tests

The script auto-detects the host platform and architecture, then runs the matching binary directly. This covers macOS (arm64, x64) and Windows (x64).

### Flags

- `--skip-docker` — skip Docker-based Linux tests (used on macOS/Windows CI runners)
- `--skip-native` — skip native binary test

## CI Workflow

`.github/workflows/release.yml` is triggered manually with `go_cli_version`, `version`, and `dry_run` inputs.

```
build (ubuntu-latest)
  ↓
smoke-test (matrix: ubuntu, macos-latest, macos-13, windows-latest)
  ↓
publish (ubuntu-latest)
  ↓
update-homebrew + update-scoop (parallel, ubuntu-latest)
```

**build** — compiles all binaries, creates archives and Linux packages, uploads as artifacts.

**smoke-test** — downloads artifacts and runs smoke-test.ts. Each runner tests what it can:

| Runner | Docker tests | Native test | npm test | Brew test | Scoop test |
|--------|-------------|-------------|----------|-----------|------------|
| ubuntu-latest | Yes | Yes | npm | No |
| macos-latest (ARM) | No | Yes | No | Yes | No |
| macos-13 (Intel) | No | Yes | No | Yes | No |
| windows-latest | No | Yes | No | No | Yes |

The npm test (`smoke-test-npm.ts`) spins up a local Verdaccio registry, publishes all packages via `bun publish`, then tests `npm install @supabase/cli` end-to-end. Brew and scoop tests use the local mode (`--local` flag) to avoid publishing to official channels during CI. Brew uses a temporary git-backed tap; scoop installs directly from the local manifest.

**publish** — publishes to npm (skipped on dry run), creates GitHub release with all artifacts.

**update-homebrew / update-scoop** — pushes updated formula/manifest to their respective repos (skipped on dry run).

## Version Management

`packages/cli-dist/scripts/sync-versions.ts` updates the `version` field across all 6 package.json files (5 platform + 1 umbrella) and the `optionalDependencies` references in the umbrella package. Run before build and before publish.
