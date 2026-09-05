# supabase

The TypeScript/Bun Supabase CLI in this repo.

This workspace contains:

- the published `supabase` package
- the `supabase` binary entrypoint
- local-development commands backed by `@supabase/stack`
- login and machine-readable output support

## Status

This workspace contains the legacy CLI shell — the stable, shipped `supabase` CLI. An experimental
next/V3 shell previously lived alongside it under `src/next/`; it has been removed.

For current migration/parity status, see:

- [`docs/go-cli-porting-status.md`](./docs/go-cli-porting-status.md) — the residual Go delegation surface
- [`docs/go-cli-divergences.md`](./docs/go-cli-divergences.md) — TS-only flags and behavioral divergences from the old Go CLI

For the generated command/reference docs, see:

- [`docs/go-cli-reference.md`](./docs/go-cli-reference.md)
- [`docs/supabase-home.md`](./docs/supabase-home.md)
- [`../../packages/stack/docs/service-versioning.md`](../../packages/stack/docs/service-versioning.md)

The README is intentionally brief. Command details should live in the generated docs and the parity tracker above.

## Run From Source

From the workspace:

```sh
cd apps/cli
pnpm dev:legacy -- --help
```

Examples:

```sh
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
pnpm build:legacy
pnpm build:shim
```

Output in `dist/`:

- `dist/supabase.js` — base shim that routes to the correct platform binary
- `dist/supabase-legacy` — legacy shell compiled binary (Bun single-file executable for the host platform)

The shim resolves `SUPABASE_CLI_BINARY_OVERRIDE` (an absolute binary path) before falling back to the `@supabase/cli-<platform>` optional-dependency lookup. The e2e test harness uses this override to invoke the real shim + compiled binary handoff against the per-shell builds in `dist/`.

### Platform releases (Bun single-file executables)

Used at release time to produce the compiled binaries that go into the platform-specific npm packages:

```sh
# legacy shell (TS SFE + Go binary for each platform)
bun scripts/build.ts --shell legacy --version X.Y.Z
```

For the legacy shell, this also cross-compiles the Go CLI binary from `apps/cli-go/` and places both binaries in `packages/cli-{platform}/bin/`.

See [`docs/binary-distribution.md`](./docs/binary-distribution.md) for a full explanation of the packaging model.

## Architecture

The CLI is built on `effect/unstable/cli`.

Important areas:

- `src/shared/cli/` for shared runner logic, roots, and global flags
- `src/legacy/commands/` for the legacy command tree
- `src/shared/output/` for text / JSON / NDJSON output policies
- `src/shared/runtime/` for TTY, stdin, browser, and process-control services
- `src/shared/auth/` for login-related services

The local stack commands use `@supabase/stack` for lifecycle, status, logs, and runtime operations.
Managed ownership uses stable loopback `GET /owner` and session-fenced `POST /stop`; same-version
runtime calls use Effect RPC over framed NDJSON at `POST /rpc`. That stack layer now has an explicit
preparation phase, so foreground and detached `start` flows can surface `Downloading` before normal
runtime states. CLI-managed stacks use lazy service startup: direct listeners and Realtime start
with the stack, while HTTP services activate on first proxied use. The package API itself keeps
eager startup as its default.

Useful companion docs:

- [`../../packages/stack/docs/architecture.md`](../../packages/stack/docs/architecture.md)

## Development

Repo-wide quality checks run from the repository root:

```sh
pnpm check:all
pnpm fix:all
```

Package-local checks and tests run from `apps/cli`:

```sh
pnpm types:check
pnpm test
```

Useful subsets:

```sh
pnpm run test:unit && pnpm run test:integration  # unit + integration (no binary required)
pnpm test:legacy-integration   # legacy behavioral tests (requires SUPABASE_GO_BINARY — see CLAUDE.md)
pnpm test:e2e                  # end-to-end subprocess tests
```

## Publishing

This workspace publishes the main `supabase` package.

Release channels are split by npm dist-tag:

- `stable` publishes the legacy shell to `latest`
- `beta` publishes the legacy shell to `beta`

The release automation lives in [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

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
