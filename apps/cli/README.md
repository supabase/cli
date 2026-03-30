# @supabase/cli

The TypeScript/Bun Supabase CLI in this repo.

This workspace contains:

- the published `@supabase/cli` package
- the `supabase` binary entrypoint
- local-development commands backed by `@supabase/stack`
- login and machine-readable output support

## Status

This CLI is still a partial TypeScript port of the old Go CLI.

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
bun src/cli/main.ts --help
```

Examples:

```sh
bun src/cli/main.ts start
bun src/cli/main.ts start --mode docker
bun src/cli/main.ts start --detach
bun src/cli/main.ts status
bun src/cli/main.ts logs
bun src/cli/main.ts login --no-browser
```

## Build

From `apps/cli`:

```sh
bun run build
```

Build output:

- `dist/supabase.js`
- `dist/bin.js`

## Architecture

The CLI is built on `effect/unstable/cli`.

Important areas:

- `src/cli/` for root command wiring and global flags
- `src/commands/` for command definitions and handlers
- `src/output/` for text / JSON / NDJSON output policies
- `src/runtime/` for TTY, stdin, browser, Ink, and process-control services
- `src/auth/` for login-related services

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
pnpm run check:all
pnpm run fix:all
pnpm run test
```

Useful subsets:

```sh
pnpm run test:core
pnpm run test:e2e
```

## Publishing

This workspace publishes the main `@supabase/cli` package.

Platform-specific wrapper packages live under:

- `packages/cli-darwin-*`
- `packages/cli-linux-*`
- `packages/cli-windows-*`
