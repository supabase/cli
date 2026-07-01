# `supabase migration repair`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                                 | Required?                                               |
| ----------------------- | --------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode          | no (falls back to keyring → `~/.supabase/access-token`) |
| `DB_PASSWORD`           | password for direct database connection | no                                                      |

## Exit Codes

| Code | Condition                          |
| ---- | ---------------------------------- |
| `0`  | success                            |
| `1`  | database connection failure        |
| `1`  | invalid or missing `--status` flag |

## Output

### `--output-format text` (Go CLI compatible)

When repairing specific versions, prints `Repaired migration history: [<versions>]
=> <status>` to stderr, then `Finished supabase migration repair.` to stdout and
the suggestion `Run supabase migration list to show the updated migration history.`
to stderr. The DB mutation is one transaction: create the history table, then (for
repair-all) `TRUNCATE`, plus `applied` → per-version `UPSERT` from the local file,
`reverted` → `DELETE ... WHERE version = ANY($1)`.

> **Atomicity note:** Go runs the TRUNCATE/UPSERT/DELETE via `pgx.Batch` (a
> pipeline, not an explicit transaction), so a partial failure mid-batch (e.g.
> TRUNCATE commits but a later UPSERT fails) can leave the history table in a
> half-updated state. The TS port wraps the same statements in an explicit
> `BEGIN`/`COMMIT` with `ROLLBACK` on error, so a partial failure leaves the table
> unchanged. This is a deliberate, safer divergence (`LegacyDbSession` has no batch
> primitive); the success path is byte-identical to Go.

### `--output-format json`

Emits `output.success("Migration history repaired", { versions, status, repairAll })`.

### `--output-format stream-json`

Same structured result delivered as an NDJSON `result` event.

## Prompts

- With no version arguments (repair-all), prompts `Do you want to repair the entire
migration history table to match local migration files?` (default **NO**).
  Declining exits non-zero (`context canceled`). `--yes` auto-confirms; a
  non-interactive / machine-output run takes the default (NO → cancel).

## Notes

- `--status` flag is required and accepts `applied` or `reverted`.
- Accepts zero or more migration version arguments; each must be numeric
  (`failed to parse <v>: invalid version number` otherwise). Zero versions enables
  repair-all.
- In `applied` mode, reads the matching `supabase/migrations/<version>_*.sql` file
  for the name + statements; a missing file exits non-zero.
- `--linked` (default true), `--local`, and `--db-url` are mutually exclusive, as
  are `--db-url` and `--password`/`-p`.
