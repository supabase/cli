# `supabase db test [path...]`

`db test` is a **hidden Go-parity alias** for `supabase test db` — Go itself
defines `db test`'s `RunE` first (`apps/cli-go/cmd/db.go:422-429`, `Hidden:
true`) and then has `test db` borrow it verbatim
(`apps/cli-go/cmd/test.go:19-20`: `RunE: dbTestCmd.RunE`). The native TS port
mirrors that shape: `test.command.ts` reuses `test db`'s flag config and
assembled handler verbatim (`../../../shared/legacy-test-db.command-handler.ts`'s
`legacyTestDbConfig` / `legacyRunTestDbCommand`) rather than re-implementing
pgTAP enable/disable and the `pg_prove` docker invocation a second time
(CLI-1962).

**Every side effect below is identical to `supabase test db`** — see
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md) for the full
inventory (docker bind-mount rules, network selection, TLS/DNS resolver
behavior, pooler-URL handling, etc.). This file exists per the "every legacy
command needs its own `SIDE_EFFECTS.md`" mandate and only calls out what is
genuinely different for this entry point.

## Files Read

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#files-read).

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Database

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#database).

## Docker

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#docker).

## API Routes (`--linked` only)

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#api-routes---linked-only).

## Environment Variables

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#environment-variables).

## Exit Codes

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#exit-codes).

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                    |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags`, **`command: "db test"`** — NOT `"test db"`, despite the identical handler |

The recorded `command` property is the only observable difference between
the two entry points. Go's `cli_command_executed` telemetry records
`strings.TrimSpace(cmd.CommandPath())` (`apps/cli-go/cmd/root_analytics.go:33`),
which differs between the two `cobra.Command` registrations even though
`RunE` is the literal same function reference. The TS port matches this via
`legacyTestDbRuntimeLayer(["db", "test"])` in `test.command.ts` (vs
`legacyTestDbRuntimeLayer(["test", "db"])` for `test db`'s own command file) —
see `../../../shared/legacy-test-db.layers.ts`'s doc comment.

## Output

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#output).

## Notes

- Native TypeScript port (Phase 1+); no Go proxy (CLI-1962). Hidden command —
  registered with `.pipe(Command.withHidden)` in `../db.command.ts`, matching
  cobra's `Hidden: true` on `dbTestCmd`.
- `--local` defaults to `true` on both `db test` and `test db`
  (`apps/cli-go/cmd/db.go:739`, `apps/cli-go/cmd/test.go:43`), matching cobra's
  `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` group — bare
  `supabase db test` always targets the local stack. This resolves the
  proxy-only `--local` default-modelling caveat that existed while this
  command still forwarded to the Go binary (the previous proxy's
  `if (flags.local) args.push("--local")` never actually forwarded the
  default, since Effect CLI's own `Flag.boolean` default is `false`; now that
  the flag drives `resolveLegacyDbTargetFlags`'s presence-based selection
  directly — same mechanism `test db` already used — Go's true default is
  reflected exactly, with no proxy-only quirk to carry over).
- Shares every intentional divergence documented on `test db`
  (pg_prove image pin, `pg_extension`-based "already exists" detection instead
  of pgx's `OnNotice`, `--network-id` global-flag override, etc.).
