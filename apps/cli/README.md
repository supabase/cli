# @supabase/cli

The TypeScript/Bun Supabase CLI in this repo.

This workspace contains:

- the published `@supabase/cli` package
- the `supabase` binary entrypoint
- local-development commands backed by `@supabase/stack`
- login and machine-readable output support

## Status

This workspace currently contains the next/V3 CLI shell and the scaffolding for a legacy shell.

For current migration/parity status, see:

- [`docs/go-cli-porting-status.md`](/Users/jgoux/Code/supabase/dx-labs/apps/cli/docs/go-cli-porting-status.md)

For the generated command/reference docs, see:

- [`docs/go-cli-reference.md`](/Users/jgoux/Code/supabase/dx-labs/apps/cli/docs/go-cli-reference.md)
- [`docs/supabase-home.md`](/Users/jgoux/Code/supabase/dx-labs/apps/cli/docs/supabase-home.md)
- [`../../packages/stack/docs/service-versioning.md`](/Users/jgoux/Code/supabase/dx-labs/packages/stack/docs/service-versioning.md)

The README is intentionally brief. Command details should live in the generated docs and the parity tracker above.

## Run From Source

From the workspace:

```sh
cd apps/cli
pnpm dev:next -- --help
```

Examples:

```sh
pnpm dev:next -- start
pnpm dev:next -- start --mode docker
pnpm dev:next -- start --detach
pnpm dev:next -- status
pnpm dev:next -- logs
pnpm dev:next -- login --no-browser
pnpm dev:legacy -- hello
```

## Build

From `apps/cli`:

```sh
pnpm build
pnpm build:next
pnpm build:legacy
pnpm build:shim
```

Build output:

- `dist/supabase.js`
- `dist/main-next.js`
- `dist/main-legacy.js`

## Architecture

The CLI is built on `effect/unstable/cli`.

Important areas:

- `src/shared/cli/` for shared runner logic, roots, and global flags
- `src/next/commands/` for the next/V3 command tree
- `src/legacy/commands/` for the legacy command tree
- `src/shared/output/` for text / JSON / NDJSON output policies
- `src/shared/runtime/` for TTY, stdin, browser, Ink, and process-control services
- `src/next/auth/` for login-related services

The local stack commands use `@supabase/stack` for lifecycle, daemon transport, status, and logs.
That stack layer now has an explicit preparation phase, so foreground and detached `start` flows
can surface `Downloading` before normal runtime states.

Useful companion docs:

- [`../../packages/stack/docs/architecture.md`](/Users/jgoux/Code/supabase/dx-labs/packages/stack/docs/architecture.md)
- [`../../packages/stack/docs/detach-mode.md`](/Users/jgoux/Code/supabase/dx-labs/packages/stack/docs/detach-mode.md)
- [`docs/ui.md`](/Users/jgoux/Code/supabase/dx-labs/apps/cli/docs/ui.md)

## Development

From `apps/cli`:

```sh
pnpm check:all
pnpm fix:all
pnpm test
```

Useful subsets:

```sh
pnpm test:core
pnpm test:e2e
```

## Publishing

This workspace publishes the main `@supabase/cli` package.

Release channels are split by npm dist-tag:

- stable publishes the legacy shell to `latest`
- alpha publishes the next/V3 shell to `alpha`

The release automation is split across:

- [`.github/workflows/release-stable.yml`](/Users/jgoux/Code/supabase/dx-labs/.github/workflows/release-stable.yml)
- [`.github/workflows/release-alpha.yml`](/Users/jgoux/Code/supabase/dx-labs/.github/workflows/release-alpha.yml)

Platform-specific wrapper packages live under:

- `packages/cli-darwin-*`
- `packages/cli-linux-*`
- `packages/cli-windows-*`
