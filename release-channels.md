## Release Channels

Adds a complete build, packaging, and distribution pipeline for publishing `@supabase/cli` across npm, Homebrew, Scoop, and GitHub Releases.

### What's included

**Multi-platform binary distribution via npm**

Uses the `optionalDependencies` pattern (same as esbuild) — 7 platform-specific packages (`@supabase/cli-{os}-{arch}`) plus an umbrella `@supabase/cli` package with a Node.js bin shim that resolves the correct binary at runtime. Linux packages include both glibc and musl variants (auto-selected via the `libc` field).

**Build pipeline** (`packages/cli/scripts/build.ts`)

Cross-compiles the Bun CLI for all targets, downloads the matching Go CLI sidecar, creates distributable archives (tar.gz/zip), generates Linux packages (.deb, .rpm, .apk via nfpm), and writes a checksums file.

**Distribution scripts**

- `publish.ts` — publishes all packages to npm (platform packages in parallel, then umbrella)
- `update-homebrew.ts` — generates and pushes a Homebrew formula to `supabase/homebrew-tap`
- `update-scoop.ts` — generates and pushes a Scoop manifest to `supabase/scoop-bucket`
- `sync-versions.ts` — stamps a version across all 8 package.json files

**Smoke tests** (`packages/cli/tests/`)

Per-OS test files (Linux, macOS, Windows) with a thin entry point that detects the platform and delegates. Each file tests the distribution channels relevant to its OS (native binary, Docker packages, npm via Verdaccio, Homebrew, Scoop).

**CI workflow** (`.github/workflows/release.yml`)

Manual dispatch with `go_cli_version`, `version`, and `dry_run` inputs. Builds on Ubuntu, smoke-tests across a matrix (Ubuntu, macOS ARM, macOS Intel, Windows), then publishes to npm + GitHub Releases + Homebrew + Scoop.

### Design decisions

- All build/distribution scripts live inside `packages/cli/` — the `files: ["dist/"]` field ensures none of them are shipped to npm
- Platform packages use `workspace:*` references in `optionalDependencies` — Bun replaces these with actual versions at publish time
- GitHub Releases use a draft-then-publish pattern to ensure immutability

### New files

| Path | Purpose |
|------|---------|
| `packages/cli/scripts/build.ts` | Cross-compile + package all targets |
| `packages/cli/scripts/publish.ts` | Publish to npm |
| `packages/cli/scripts/sync-versions.ts` | Stamp version across all packages |
| `packages/cli/scripts/update-homebrew.ts` | Generate + push Homebrew formula |
| `packages/cli/scripts/update-scoop.ts` | Generate + push Scoop manifest |
| `packages/cli/tests/smoke-test*.ts` | Per-OS smoke test files + shared helpers |
| `packages/cli-{os}-{arch}/` | 7 platform packages |
| `.github/workflows/release.yml` | CI release workflow |
| `docs/cli-distribution.md` | Architecture documentation |
