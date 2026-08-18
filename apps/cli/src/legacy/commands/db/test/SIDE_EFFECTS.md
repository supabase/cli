# `supabase db test [path...]`

`db test` is a **hidden alias** for `supabase test db`. The native TS port
shares the same flag config and handler: `test.command.ts` reuses `test db`'s
flag config and assembled handler verbatim
(`../../../shared/legacy-test-db.command-handler.ts`'s
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
the two entry points, since each command's own telemetry wrapper records its
own command path even though the underlying handler is the literal same
function reference. The TS port reflects this via
`legacyTestDbRuntimeLayer(["db", "test"])` in `test.command.ts` (vs
`legacyTestDbRuntimeLayer(["test", "db"])` for `test db`'s own command file) —
see `../../../shared/legacy-test-db.layers.ts`'s doc comment.

## Output

Identical to `test db`. See
[`../../test/db/SIDE_EFFECTS.md`](../../test/db/SIDE_EFFECTS.md#output).

## Notes

- Native TypeScript port (Phase 1+); no Go proxy (CLI-1962). Hidden command —
  registered with `.pipe(Command.unlisted)` in `../db.command.ts`.
- `--local` defaults to `true` on both `db test` and `test db` — bare
  `supabase db test` always targets the local stack. This resolves a former
  proxy-only `--local` default-modelling caveat that existed while this
  command still forwarded to the Go binary (the previous proxy's
  `if (flags.local) args.push("--local")` never actually forwarded the
  default, since Effect CLI's own `Flag.boolean` default is `false`; now that
  the flag drives `resolveLegacyDbTargetFlags`'s presence-based selection
  directly — same mechanism `test db` already used — the true default is
  reflected exactly, with no proxy-only quirk to carry over).
- Shares every intentional divergence documented on `test db`
  (pg_prove image pin, `pg_extension`-based "already exists" detection instead
  of pgx's `OnNotice`, `--network-id` global-flag override, etc.).
