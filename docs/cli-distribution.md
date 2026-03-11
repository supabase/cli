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

A single build script (`apps/cli/scripts/build.ts`) produces all artifacts from one machine (Ubuntu in CI). It takes two arguments:

- `--go-version` — the supabase/cli release to wrap (e.g. `2.75.0`)
- `--version` — the version to stamp on packages

For each of the 5 glibc targets (darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64):

1. Cross-compiles the Bun CLI via `bun build --compile --target=<target>`
2. Downloads the matching Go CLI binary from GitHub releases
3. Places both in the platform package's `bin/` directory

It then:

4. Builds musl variants of the Bun CLI for Alpine Linux (arm64 + x64) into `packages/cli-linux-{arch}-musl/bin/`
5. Creates distributable archives in `dist/` (tar.gz for Unix, zip for Windows)
6. Generates Linux packages (.deb, .rpm, .apk) via nfpm
7. Writes `dist/checksums.txt` with SHA256 hashes for all artifacts

Alpine apk packages use the musl-compiled Bun binary and declare `libstdc++` and `libgcc` as dependencies.

## Distribution Channels

### npm

Uses the platform-specific `optionalDependencies` pattern (same as esbuild):

- **Platform packages** — `@supabase/cli-darwin-arm64`, `@supabase/cli-darwin-x64`, `@supabase/cli-linux-arm64`, `@supabase/cli-linux-arm64-musl`, `@supabase/cli-linux-x64`, `@supabase/cli-linux-x64-musl`, `@supabase/cli-windows-x64`. Each declares `os` and `cpu` fields so npm only installs the matching one. Linux packages additionally use the `libc` field (`["glibc"]` or `["musl"]`) so npm auto-selects the correct variant for the host C library (e.g. Alpine Linux gets the musl package).
- **Umbrella package** — `@supabase/cli` lists all platform packages as `optionalDependencies` and includes a Node.js ESM bin shim (`bin/supabase.js`, built from `src/bin.ts` via `bun build --target node`) that resolves the correct platform binary via `createRequire` + `require.resolve`. On Linux, it tries glibc first, then falls back to musl.

Published by `apps/cli/scripts/publish.ts` using `bun publish`: platform packages first (in parallel), then the umbrella package. Supports `--dry-run`.

### Homebrew

`apps/cli/scripts/update-homebrew.ts` generates a formula (`dist/supabase.rb`) from the checksums file. The formula installs both `supabase` and `supabase-backend`.

In production, it clones the `supabase/homebrew-tap` repo, updates `Formula/supabase.rb`, commits, and pushes. With `--local`, it writes the formula with `file://` URLs for local testing.

### Scoop

`apps/cli/scripts/update-scoop.ts` generates a manifest (`dist/supabase.json`) with the Windows amd64 zip URL and hash.

In production, it pushes to `supabase/scoop-bucket`. With `--local`, it writes the manifest with `file:///` URLs for local testing.

### GitHub Releases

The release workflow creates an immutable GitHub release (draft-then-publish pattern) with versioned artifacts:

- `supabase_{version}_darwin_arm64.tar.gz`, `supabase_{version}_darwin_amd64.tar.gz`
- `supabase_{version}_linux_arm64.tar.gz`, `supabase_{version}_linux_amd64.tar.gz`
- `supabase_{version}_linux_{arm64,amd64}.{deb,rpm,apk}`
- `supabase_{version}_windows_amd64.zip`
- `checksums.txt`

The release is first created as a draft with all assets attached, then published in a separate step. Once published, the tag and assets are locked and cannot be modified.

## Smoke Tests

Smoke tests are organized into per-OS files so it's immediately clear which tests run on which platform. An entry point (`smoke-test.ts`) detects the OS and delegates to the matching file.

```
apps/cli/tests/
  smoke-test.ts              # entry point: detects OS, delegates to per-OS file
  smoke-test-linux.ts        # native + docker + npm
  smoke-test-macos.ts        # native + npm + brew
  smoke-test-windows.ts      # native + scoop
  helpers/
    npm-registry.ts          # shared Verdaccio helpers (used by linux + macos)
```

### Running locally

```bash
# Run the tests for your current OS
cd apps/cli && bun run test:smoke

# With a specific version (must match the version used to build dist/ artifacts)
bun run test:smoke --version 2.75.0

# Run a per-OS file directly
bun run tests/smoke-test-macos.ts --version 0.0.1-smoke
```

### Linux tests (`smoke-test-linux.ts`)

- **Native** — runs `packages/cli-linux-{x64,arm64}/bin/supabase --version`
- **Docker** — tests all Linux package formats across arm64 and amd64 (8 tests total, run in parallel):

| Test | Image | Method |
|------|-------|--------|
| `linux-{arch}-tarball` | `debian:bookworm-slim` | `tar -xzf` + run |
| `linux-{arch}-deb` | `debian:bookworm-slim` | `dpkg -i` + run |
| `linux-{arch}-rpm` | `amazonlinux:2023` | `rpm -ivh` + run |
| `linux-{arch}-apk` | `alpine:3.21` | `apk add --allow-untrusted` + run |

- **npm** — spins up a local Verdaccio registry, publishes all packages, tests `npm install @supabase/cli` end-to-end

### macOS tests (`smoke-test-macos.ts`)

- **Native** — runs `packages/cli-darwin-{arm64,x64}/bin/supabase --version`
- **npm** — same Verdaccio-based end-to-end test as Linux
- **Brew** — generates a formula with `--local` (file:// URLs), creates a temporary git-backed tap, installs via `brew install`, verifies, and cleans up. Skips if `brew` is not found.

### Windows tests (`smoke-test-windows.ts`)

- **Native** — runs `packages/cli-windows-x64/bin/supabase.exe --version`
- **Scoop** — generates a manifest with `--local` (file:/// URLs), installs via `scoop install`, verifies, and cleans up. Skips if `scoop` is not found.

## CI Workflow

`.github/workflows/release.yml` is triggered manually with `go_cli_version`, `version`, and `dry_run` inputs.

```
build (ubuntu-latest)
  ↓
smoke-test (matrix: ubuntu, macos-latest, macos-15-intel, windows-latest)
  ↓
publish (ubuntu-latest)
  ↓
update-homebrew + update-scoop (parallel, ubuntu-latest)
```

**build** — compiles all binaries, creates archives and Linux packages, uploads as artifacts.

**smoke-test** — downloads artifacts and runs `bun run test:smoke --version <version>`. Each runner runs the per-OS test file automatically:

| Runner | Tests run |
|--------|-----------|
| ubuntu-latest | native (x64, arm64) + docker (8 tests) + npm |
| macos-latest (ARM) | native (arm64, x64) + npm + brew |
| macos-15-intel (Intel) | native (arm64, x64) + npm + brew |
| windows-latest | native (x64) + scoop |

**publish** — publishes to npm (skipped on dry run), creates an immutable GitHub release (draft + publish) with all versioned artifacts.

**update-homebrew / update-scoop** — pushes updated formula/manifest to their respective repos (skipped on dry run).

## Version Management

`apps/cli/scripts/sync-versions.ts` updates the `version` field across all 8 package.json files (7 platform + 1 umbrella) and replaces `workspace:*` references in `optionalDependencies` with explicit versions. Run before build and before publish.
