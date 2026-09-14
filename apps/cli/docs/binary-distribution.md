# Binary Distribution

This document explains how the Supabase CLI is packaged and distributed, covering the two-binary model used by the CLI.

## Overview

The CLI is distributed as a set of platform-specific npm packages. Each platform package contains two binaries:

```
@supabase/cli-darwin-arm64/
└── bin/
    ├── supabase       ← TypeScript CLI (Bun single-file executable)
    └── supabase-go    ← Go CLI binary (unused by supabase; ships until apps/cli-go/ is deleted)
```

The base `supabase` package routes to the correct platform package via `src/shared/cli/bin.ts`, which resolves and `execFileSync`s the platform-specific `bin/supabase` binary.

## Why Two Binaries

The CLI was built as a gradual TypeScript port of the Go CLI, moving each command through two phases:

- **Phase 0** — The command is defined in the TS CLI tree but proxied to the Go binary at runtime via `GoProxy`.
- **Phase 1+** — The command is implemented natively in TypeScript.

That port is complete (CLI-1970), and the last residual delegation surface — `db diff`
(`--use-pg-schema`), the `db branch`/`db remote changes` command families, `gen keys`, and
`functions download` (`--legacy-bundle`) — was removed rather than ported (CLI-2432): those
command paths are now tombstones (or, for `--legacy-bundle`, deleted outright) that never spawn
`supabase-go`. The TS binary (`supabase`) no longer needs `supabase-go` on the same system for
anything. `apps/cli-go/` and `supabase-go` still build and ship alongside `supabase` today, unused,
until the tree itself is deleted in a follow-up.

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

Nothing in the TypeScript CLI resolves or spawns `supabase-go` anymore (CLI-2432 removed the last
callers); `SUPABASE_GO_BINARY` is no longer read anywhere in `apps/cli/src`.

## Source of the Go Binary

The Go CLI source lives in `apps/cli-go/` and is managed via:

```sh
pnpm repos:install
```

This must be run after a fresh clone before building a release.

## Development Workflow

No build step is required to run the CLI from source, and no Go binary needs to be resolvable.

1. Create a shell alias to run the CLI from source. For example in `.zshrc`:

   ```sh
   alias supabase-dev="bun /path/to/dx-lab/apps/cli/src/main.ts"
   ```

2. Run commands directly:

   ```sh
   supabase-dev login
   ```

## Release Workflow

The `scripts/build.ts` script compiles both binaries for all target platforms:

```sh
bun scripts/build.ts --version X.Y.Z
```

This:

1. Compiles the TS CLI to a Bun SFE for each platform → `packages/cli-{platform}/bin/supabase`
2. Cross-compiles the Go CLI (`CGO_ENABLED=0`) for each platform → `packages/cli-{platform}/bin/supabase-go`
3. Signs the macOS binaries (both `supabase` and `supabase-go`) before archiving, so every channel ships the signed bytes — see [release-process.md § Code signing (macOS)](./release-process.md#code-signing-macos) and [ADR 0014](../../../docs/adr/0014-macos-code-signing-and-notarization.md)
4. Bundles both binaries into the platform archives (`.tar.gz` / `.zip`)
5. Includes both binaries in the Linux package manager packages (deb/rpm/apk)

### Go binary command surface

As of CLI-2432, nothing in the TypeScript CLI spawns `supabase-go` — the last delegation surface
(`db diff --use-pg-schema`, `db branch create|delete|list|switch`, `db remote changes`, `gen keys`,
`functions download --legacy-bundle`) was removed rather than ported: the first four command paths
are tombstones that fail with a removal error, and `--legacy-bundle` was deleted outright. `apps/cli-go/`
and `supabase-go` are unused dead weight in the shipped packages until the tree itself is deleted
in a follow-up.

Everything else the original Go CLI implemented was deleted outright from `apps/cli-go/` (CLI-1970), not just excluded from the shipped binary. The reachable set was computed with a `go list -deps -test` fixpoint from the trimmed `main` package, and everything outside it was removed: the main module's first-party package count went from 138 to 38 (100 packages / ~29.5k LOC across 321 files deleted), including every other command's `cmd/*.go` file, `internal/{inspect,storage,sso,login,link,init,bootstrap}`, `internal/migration/{squash,up,fetch}`, the Go docs generator (`docs/`), `examples/`, and `tools/{jsonschema,shared}`. Counting stdlib and third-party dependencies too, the full dependency closure shrank from 1078 to 959 packages. `pkg/` (a separate, independently tagged/published Go module for external consumers) and `tools/listdep` (used by `cli-go-mirror.yml`) were left untouched.

For any command or package deleted by CLI-1970, the parity/provenance reference is the last commit with the full source intact: `7b469f5b3` — the same convention CLI-1966 established for `internal/start` (see below).

### Binary size

Measured on the CLI-1970 branch with the real release build (`build.ts`, `go build -trimpath -ldflags "-s -w"`, `CGO_ENABLED=0`):

| Platform      | `supabase-go` size |
| ------------- | -----------------: |
| darwin-arm64  |            40.1 MB |
| darwin-x64    |            42.6 MB |
| linux-arm64   |            39.1 MB |
| linux-x64     |            41.8 MB |
| windows-arm64 |            39.5 MB |
| windows-x64   |            42.8 MB |

(musl packages ship the glibc `supabase-go` binary — see Package Layout above.)

Progression across both trims: the original two-binary baseline was 97–103 MB per platform; CLI-1966's `internal/start` deletion cut it to roughly 47–52 MB; CLI-1970 brings it to 39.1–42.8 MB.

The remaining size is dominated by dependencies the now-unreachable command set still links against: `stripe/pg-schema-diff`, the Docker client (shadow-database provisioning), pgx, the Management API client, cobra/viper, and sentry/posthog.

Release archive sizes (TS `supabase` binary + `supabase-go` together): `.tar.gz` 37.9–52.9 MB, `.zip` (Windows) 50.0–53.0 MB, `.deb` 52.7–53.4 MB, `.rpm` 52.3–53.2 MB, `.apk` 52.8–54.1 MB.

### Historical note: CLI-1966 (`internal/start` deletion)

`apps/cli-go/internal/start` (Go's `supabase start` implementation) was the first package deleted outright rather than excluded from the build. Native TS `start` talks to Docker directly and never proxied to Go for it, and a repo-wide grep confirmed no other TS→Go delegation seam called into it either. `internal/start` alone had previously accounted for roughly half the shipped Go binary's size via its exclusive dependency tree (docker-compose/v2, buildx, buildkit, k8s client-go, aws-sdk-go-v2, notary, secret-detector). The last commit with the source intact is `a253ccba2` (full hash `a253ccba25c21356ccd33044c4474aecb77d1ae4`).

## See Also

- [ADR 0011](../../../docs/adr/0011-cli-release-and-distribution-strategy.md) — the release & distribution strategy decision (binary packaging choice, per-channel publish mechanisms, CI pipeline design, open blockers).
- [`release-process.md`](./release-process.md) — operational playbook for local, PoC, and production releases.
