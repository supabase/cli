# `supabase db test [path...]`

`db test` is a **hidden alias** for `supabase test db`. It
shares the same flag config and handler: `test.command.ts` reuses `test db`'s
flag config and assembled handler verbatim
(`../../../shared/test-db.command-handler.ts`'s
`testDbConfig` / `runTestDbCommand`) rather than re-implementing
pgTAP enable/disable and the `pg_prove` docker invocation a second time
(CLI-1962).

**Every side effect below is identical to `supabase test db`** — see
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md) for the full
inventory (docker bind-mount rules, network selection, TLS/DNS resolver
behavior, pooler-URL handling, etc.). This file exists per the "every
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
the two entry points, since each command's own telemetry wrapper records its
own command path even though the underlying handler is the literal same
function reference. This is wired via
`testDbRuntimeLayer(["db", "test"])` in `test.command.ts` (vs
`testDbRuntimeLayer(["test", "db"])` for `test db`'s own command file) —
see `../../../shared/test-db.layers.ts`'s doc comment.

## Output

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#output).

## Notes

- Hidden command —
  registered with `.pipe(Command.unlisted)` in `../db.command.ts`.
- `--local` defaults to `true` on both `db test` and `test db` — bare
  `supabase db test` always targets the local stack. The flag drives
  `resolveDbTargetFlags`'s presence-based selection directly, the same
  mechanism `test db` uses, so the true default is reflected exactly.
- Shares every behavior documented on `test db` (pg_prove image pin,
  `pg_extension`-based "already exists" detection, global `--network-id` handling, etc.).
