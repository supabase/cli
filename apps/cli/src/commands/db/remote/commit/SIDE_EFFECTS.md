# `supabase db remote commit`

Deprecated wrapper around native `db pull`. Commits remote schema changes as
`<timestamp>_remote_commit.sql` using the in-process pg-delta (or migra) engine.
`--experimental` / `SUPABASE_EXPERIMENTAL` take the same in-process declarative
export as `db pull --experimental` (Go's `pull.Run` honored that gate for
commit too). Does not print `Finished supabase db pull.` Every invocation
prints cobra's `Command "commit" is deprecated, use "db pull" instead.` to
stderr.

See [`db/pull/SIDE_EFFECTS.md`](../../pull/SIDE_EFFECTS.md) for the shared
migration-style pull surface (shadow, cache, API, history repair). Differences
from `db pull`:

- Migration stem is always `remote_commit` (not `remote_schema` or a `--name`).
- No `--declarative` / `--use-pg-delta` / `--diff-engine` / `--local` / `--project-ref`.
- `--linked` defaults to false in the TS flag parser; omitting it still targets
  the linked project (same as Go's `--linked` default true). Passing `--linked`
  is explicit.
- No Go proxy, no edge-runtime pg-delta, no `pgdelta-version` / `PGDELTA_NPM_REGISTRY`.

## Files Read

Same as migration-style `db pull`.

## Files Written

| Path                                                          | Format | When                                                 |
| ------------------------------------------------------------- | ------ | ---------------------------------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_remote_commit.sql` | SQL    | non-empty diff (or the initial-migra `pg_dump` seed) |
| `<workdir>/supabase/schemas/**`                               | SQL    | `--experimental` / `SUPABASE_EXPERIMENTAL` export    |
| `<workdir>/supabase/schemas/.pgdelta-export.json`             | JSON   | experimental export metadata                         |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`       | JSON   | bundled engine with `PGDELTA_DEBUG`                  |

Plus the shared pull post-run writes (linked-project cache, telemetry, shadow
baseline cache).

## API Routes / DB

Same as migration-style `db pull`.

## Environment Variables

Same as `db pull`. `SUPABASE_EXPERIMENTAL` selects the deprecated in-process
declarative export.

## Exit Codes

| Code | Condition                                                |
| ---- | -------------------------------------------------------- |
| `0`  | success                                                  |
| `1`  | same as migration-style `db pull` (including empty diff) |

## Output

### `--output-format text`

Prints the cobra deprecation line, then `Schema written to <path>` (or the
declarative export lines) to stderr on success. No stdout confirmation and no
`Finished supabase db pull.` PostRun line.

### `--output-format json` / `stream-json`

Same envelope as migration-style `db pull`.

## Notes

- Deprecated: use `db pull` instead.
- pg-delta is the default shadow-diff engine, running in-process exactly as for
  migration-style `db pull`. Rollback is `[experimental.pgdelta] enabled = false`
  in `config.toml` — this command has no per-run engine flag, so it always follows
  the config default.
- `--schema` / `-s` restricts the commit to specific schemas.
- `--db-url` and `--linked` are mutually exclusive.
