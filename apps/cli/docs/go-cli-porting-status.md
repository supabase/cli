# Go CLI Delegation

> Still named `go-cli-porting-status.md` for historical reasons — the per-command porting tracker
> this file once held is gone now that the port is done; it documents only the residual Go
> delegation surface below.

The Go→TypeScript legacy port is complete (CLI-1970). The bundled `supabase-go` binary and the
`apps/cli-go/` tree contain **only** the delegation surface in the table below — Go source for
every other command was deleted outright once nothing in the TypeScript CLI could reach it,
directly or indirectly. For any other command's former Go source, the reference is the last commit
with it intact: `7b469f5b3` (CLI-1966's `internal/start` pin remains its own, separate commit,
`a253ccba2`).

See [`binary-distribution.md`](./binary-distribution.md) for how these two binaries are packaged,
resolved at runtime, and sized. The TypeScript CLI is the source of truth for all CLI behavior;
`apps/cli-go/` is authoritative only for the proxied commands below, and the whole surface is
slated for cleanup and removal ([ADR 0016](../../../docs/adr/0016-legacy-port-completion-and-go-cli-authority-scope.md)
records the earlier transition policy).

## The delegation surface

| Command/path                                                    | TS proxy site                                                                                                   | Go implementation (in-tree)                                                   | Why it stays                                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `db diff --use-pg-schema`                                       | [`src/legacy/commands/db/diff/diff.handler.ts`](../src/legacy/commands/db/diff/diff.handler.ts) (delegate path) | `internal/db/diff/pgschema.go`                                                | Wraps the Go-only `stripe/pg-schema-diff` library (CLI-1960); deprecated but sanctioned.                                             |
| `db pull --experimental` (structured dump)                      | [`src/legacy/commands/db/pull/pull.handler.ts`](../src/legacy/commands/db/pull/pull.handler.ts)                 | `internal/migration/format.WriteStructuredSchemas` + the multigres DDL parser | No TS DDL parser equivalent (CLI-1957).                                                                                              |
| `db branch create\|delete\|list\|switch`                        | `src/legacy/commands/db/branch/*/`                                                                              | `legacy/branch/*`                                                             | Go-deprecated wrapped commands kept indefinitely (CLI-1964 cancelled: dropping them was ruled a breaking change not worth shipping). |
| `db remote changes\|commit`                                     | `src/legacy/commands/db/remote/*/`                                                                              | inline in `cmd/db.go` over `internal/db/{diff,pull}`                          | Same CLI-1964 ruling.                                                                                                                |
| `gen keys`                                                      | `src/legacy/commands/gen/keys/`                                                                                 | `legacy/keys`                                                                 | Same ruling; requires `--experimental`.                                                                                              |
| `functions download --legacy-bundle` (hidden flag; both shells) | `src/shared/functions/download.ts` `makeGoProxyLegacyBundleArgs`                                                | `internal/functions/download`                                                 | Legacy Deno bundle extraction (CLI-1963).                                                                                            |

## Mechanics

All delegation goes through the shared `LegacyGoProxy` service
([`src/shared/legacy/go-proxy.service.ts`](../src/shared/legacy/go-proxy.service.ts),
[`go-proxy.layer.ts`](../src/shared/legacy/go-proxy.layer.ts)):

- **Binary resolution order**: `SUPABASE_GO_BINARY` env var → binary co-located with the compiled
  shim → the platform's `@supabase/cli-<platform>` npm package. There is deliberately **no**
  `PATH` fallback (CLI-1488: the shim itself is what's on `PATH`, so falling back would re-invoke
  it and fork-bomb) — resolution failure is a hard error with install guidance. PATH-installed
  setups work via the co-location step: `supabase-go` sits next to the `supabase` shim.
- **Global-flag forwarding**: `legacy/cli/root.ts` translates the legacy shell's global flags
  (`--output`, `--profile`, `--debug`, `--workdir`, `--experimental`, `--network-id`, `--yes`,
  `--dns-resolver`, `--create-ticket`, `--agent`) into Go-style argv ahead of every proxied
  invocation.
- **Child telemetry suppression**: a proxy handler that itself owns the parent
  `cli_command_executed` event (wrapped in TS command instrumentation) suppresses the child's own
  telemetry; a bare pass-through proxy leaves it enabled so the Go child stays the sole emitter.

The spawn surface is guarded by
[`apps/cli-e2e/src/tests/go-binary-surface.e2e.test.ts`](../../cli-e2e/src/tests/go-binary-surface.e2e.test.ts) —
trimming the binary past this surface fails CI.

The former pg-delta `__catalog`/`db start` seam (spawned directly by `db schema declarative
generate|sync`, outside `LegacyGoProxy`) was ported native in CLI-1970 and no longer exists.

## See also

TS-only flags and deliberate behavioral divergences from the old Go CLI live in
[`go-cli-divergences.md`](./go-cli-divergences.md).
