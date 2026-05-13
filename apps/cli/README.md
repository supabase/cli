# supabase

The TypeScript/Bun Supabase CLI in this repo.

This workspace contains:

- the published `supabase` package
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

### Legacy shell and the Go binary

Phase 0 commands in the legacy shell proxy to the Go CLI binary. To run these commands from source you need `supabase` (the Go CLI) available on your PATH.

For convenience, create a shell alias instead of using `pnpm dev:legacy` directly. For example in `.zshrc`:

```sh
alias supabase-dev="bun /absolute/path/to/dx-lab/apps/cli/src/legacy/main.ts"
```

Then Phase 0 commands resolve the Go binary via PATH automatically:

```sh
supabase-dev orgs list   # proxied to supabase on PATH
supabase-dev login       # native TypeScript
```

You can also point `SUPABASE_GO_BINARY` at a specific binary to skip the PATH lookup:

```sh
export SUPABASE_GO_BINARY=/path/to/supabase
```

## Build

There are two separate build paths depending on what you need.

### Source bundles (development)

From `apps/cli`:

```sh
pnpm build
pnpm build:next
pnpm build:legacy
pnpm build:shim
```

Output in `dist/`:

- `dist/supabase.js` — base shim that routes to the correct platform binary
- `dist/supabase-next` — next shell compiled binary (Bun single-file executable for the host platform)
- `dist/supabase-legacy` — legacy shell compiled binary (Bun single-file executable for the host platform)

The shim resolves `SUPABASE_CLI_BINARY_OVERRIDE` (an absolute binary path) before falling back to the `@supabase/cli-<platform>` optional-dependency lookup. The e2e test harness uses this override to invoke the real shim + compiled binary handoff against the per-shell builds in `dist/`.

### Platform releases (Bun single-file executables)

Used at release time to produce the compiled binaries that go into the platform-specific npm packages:

```sh
# next shell (TS only)
bun scripts/build.ts --shell next --version X.Y.Z

# legacy shell (TS SFE + Go binary for each platform)
bun scripts/build.ts --shell legacy --version X.Y.Z
```

For the legacy shell, this also cross-compiles the Go CLI binary from `apps/cli-go/` and places both binaries in `packages/cli-{platform}/bin/`.

See [`docs/binary-distribution.md`](./docs/binary-distribution.md) for a full explanation of the packaging model.

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
pnpm test:core                 # unit + integration (no binary required)
pnpm test:legacy-integration   # legacy behavioral tests (requires SUPABASE_GO_BINARY — see CLAUDE.md)
pnpm test:e2e                  # end-to-end subprocess tests
```

## Publishing

This workspace publishes the main `supabase` package.

Release channels are split by npm dist-tag:

- stable publishes the legacy shell to `latest`
- alpha publishes the next/V3 shell to `alpha`

The release automation is split across:

- [`.github/workflows/release-stable.yml`](../../.github/workflows/release-stable.yml)
- [`.github/workflows/release-alpha.yml`](../../.github/workflows/release-alpha.yml)

### Platform packages

Platform-specific packages live under:

- `packages/cli-darwin-*`
- `packages/cli-linux-*`
- `packages/cli-windows-*`

Each platform package ships two binaries for the legacy stable channel:

- `bin/supabase` — the compiled TypeScript SFE (Bun single-file executable)
- `bin/supabase-go` — the compiled Go CLI binary, used by Phase 0 proxy commands

The Go binary is compiled from `apps/cli-go/` at release time. Run `pnpm repos:install` after a fresh clone to make that source available.

See [`docs/binary-distribution.md`](./docs/binary-distribution.md) for the full packaging model.
