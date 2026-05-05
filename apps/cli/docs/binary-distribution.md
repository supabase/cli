# Binary Distribution

This document explains how the Supabase CLI is packaged and distributed, covering the two-binary model used by the legacy shell.

## Overview

The CLI is distributed as a set of platform-specific npm packages. Each platform package contains two binaries:

```
@supabase/cli-darwin-arm64/
└── bin/
    ├── supabase       ← TypeScript CLI (Bun single-file executable)
    └── supabase-go    ← Go CLI binary (for Phase 0 proxy commands)
```

The base `@supabase/cli` package routes to the correct platform package via `src/shared/cli/bin.ts`, which resolves and `execFileSync`s the platform-specific `bin/supabase` binary.

## Why Two Binaries

The legacy shell is a gradual TypeScript port of the Go CLI. Commands are ported in phases:

- **Phase 0** — The command is defined in the TS CLI tree but proxied to the Go binary at runtime via `LegacyGoProxy`.
- **Phase 1+** — The command is implemented natively in TypeScript.

During Phase 0, the TS binary (`supabase`) needs the Go binary (`supabase-go`) available on the same system. Once all commands are ported to TypeScript, the Go binary will no longer be needed.

## Package Layout

```
packages/
  cli-darwin-arm64/bin/   supabase + supabase-go
  cli-darwin-x64/bin/     supabase + supabase-go
  cli-linux-arm64/bin/    supabase + supabase-go
  cli-linux-x64/bin/      supabase + supabase-go
  cli-linux-arm64-musl/bin/ supabase (musl TS binary only)
  cli-linux-x64-musl/bin/   supabase (musl TS binary only)
  cli-windows-arm64/bin/  supabase.exe + supabase-go.exe
  cli-windows-x64/bin/    supabase.exe + supabase-go.exe
```

The musl packages only carry the Bun TS binary (compiled for musl). The Go binary is statically linked (`CGO_ENABLED=0`), so the glibc Linux binary works on musl as well — it is installed alongside the musl TS binary by the Linux package managers (deb/rpm/apk) from the glibc build.

## Runtime Resolution

When a Phase 0 command runs, `go-proxy.layer.ts` resolves the Go binary in this order:

1. **`SUPABASE_GO_BINARY` env var** — explicit override, takes priority.
2. **Co-located `supabase-go`** — looks next to `process.execPath`. Works in compiled SFE mode because the base shim uses `execFileSync`, making the TS SFE the main process with `process.execPath` pointing to itself.
3. **npm package resolution** — resolves `@supabase/cli-{platform}/bin/supabase-go`. Works when running from source with the platform packages installed.
4. **`supabase` on PATH** — final fallback, useful for local development.

## Source of the Go Binary

The Go CLI source lives in `.repos/supabase-cli-go/` and is managed via:

```sh
pnpm repos:install
```

This must be run after a fresh clone before building a legacy release.

## Development Workflow

No build step is required to run the legacy CLI from source. The PATH fallback handles Go binary resolution automatically.

1. Install the Go CLI on your PATH (via npm, brew, or building from `.repos/supabase-cli-go/`).
2. Create a shell alias to run the legacy CLI from source. For example in `.zshrc`:

   ```sh
   alias supabase-dev="bun /path/to/dx-lab/apps/cli/src/legacy/main.ts"
   ```

3. Run commands:

   ```sh
   supabase-dev orgs list    # Phase 0: proxied to Go binary on PATH
   supabase-dev login        # Phase 1+: native TypeScript implementation
   ```

Alternatively, set `SUPABASE_GO_BINARY` to point to a specific binary:

```sh
export SUPABASE_GO_BINARY=/path/to/supabase
```

## Release Workflow

The `scripts/build.ts` script compiles both binaries for all target platforms when `--shell legacy` is passed:

```sh
bun scripts/build.ts --shell legacy --version X.Y.Z
```

This:

1. Compiles the TS CLI to a Bun SFE for each platform → `packages/cli-{platform}/bin/supabase`
2. Cross-compiles the Go CLI (`CGO_ENABLED=0`) for each platform → `packages/cli-{platform}/bin/supabase-go`
3. Bundles both binaries into the platform archives (`.tar.gz` / `.zip`)
4. Includes both binaries in the Linux package manager packages (deb/rpm/apk)

## See Also

- [ADR 0011](../../../docs/adr/0011-cli-release-and-distribution-strategy.md) — the release & distribution strategy decision (binary packaging choice, per-channel publish mechanisms, CI pipeline design, open blockers).
- [`release-process.md`](./release-process.md) — operational playbook for local, PoC, and production releases.
