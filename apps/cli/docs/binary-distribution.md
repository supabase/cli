# Binary Distribution

This document explains how the Supabase CLI is packaged and distributed as a compiled binary per platform.

## Overview

The CLI is distributed as a set of platform-specific npm packages. Each platform package contains one binary:

```
@supabase/cli-darwin-arm64/
└── bin/
    └── supabase       ← TypeScript CLI (Bun single-file executable)
```

The base `supabase` package routes to the correct platform package via `src/shared/cli/bin.ts`, which resolves and `execFileSync`s the platform-specific `bin/supabase` binary.

## Package Layout

```
packages/
  cli-darwin-arm64/bin/      supabase
  cli-darwin-x64/bin/        supabase
  cli-linux-arm64/bin/       supabase
  cli-linux-x64/bin/         supabase
  cli-linux-arm64-musl/bin/  supabase
  cli-linux-x64-musl/bin/    supabase
  cli-windows-arm64/bin/     supabase.exe
  cli-windows-x64/bin/       supabase.exe
```

## Development Workflow

No build step is required to run the CLI from source.

1. Create a shell alias to run the CLI from source. For example in `.zshrc`:

   ```sh
   alias supabase-dev="bun /path/to/dx-lab/apps/cli/src/main.ts"
   ```

2. Run commands directly:

   ```sh
   supabase-dev login
   ```

## Release Workflow

The `scripts/build.ts` script compiles the binary for all target platforms:

```sh
bun scripts/build.ts --version X.Y.Z
```

This:

1. Compiles the TS CLI to a Bun SFE for each platform → `packages/cli-{platform}/bin/supabase`
2. Signs the macOS binaries before archiving, so every channel ships the signed bytes — see [release-process.md § Code signing (macOS)](./release-process.md#code-signing-macos) and [ADR 0014](../../../docs/adr/0014-macos-code-signing-and-notarization.md)
3. Bundles the binary into the platform archives (`.tar.gz` / `.zip`)
4. Includes the binary in the Linux package manager packages (deb/rpm/apk)

## History

The CLI was originally a two-binary distribution during its gradual port from a Go CLI to
TypeScript: a `supabase` Bun single-file executable alongside a `supabase-go` binary that the TS
CLI proxied to for not-yet-ported commands. The port completed (CLI-1970), the last residual
delegation surface was removed (CLI-2432), and the Go source tree (`apps/cli-go/`) was deleted in
the same effort — the CLI now ships as a single compiled binary per platform. See
[ADR 0026](../../../docs/adr/0026-go-cli-removal.md) for the full removal record.

## See Also

- [ADR 0011](../../../docs/adr/0011-cli-release-and-distribution-strategy.md) — the release & distribution strategy decision (binary packaging choice, per-channel publish mechanisms, CI pipeline design, open blockers).
- [ADR 0026](../../../docs/adr/0026-go-cli-removal.md) — the Go CLI removal decision record.
- [`release-process.md`](./release-process.md) — operational playbook for local, PoC, and production releases.
