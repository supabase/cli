# `supabase db schema declarative sync`

## Files Read

| Path                                                         | Format | When   |
| ------------------------------------------------------------ | ------ | ------ |
| `<workdir>/supabase/database/<schema>.sql` (declarative dir) | SQL    | always |

> Note: This path can be changed by setting the following in `config.toml`
>
> ```
> [experimental.pgdelta]
> declarative_schema_path = "./database"
> ```

## Files Written

| Path                                                   | Format | When                          |
| ------------------------------------------------------ | ------ | ----------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_<name>.sql` | SQL    | when schema changes are found |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                               | Required? |
| ----------------------- | ------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (not used by this command) | no        |

## Exit Codes

| Code | Condition                                       |
| ---- | ----------------------------------------------- |
| `0`  | success (migration created or no changes found) |
| `1`  | no declarative schema files found               |
| `1`  | shadow database error                           |
| `1`  | migration apply error (when `--apply` is set)   |
| `1`  | both `--apply` and `--no-apply` (mutual exclusivity) |

## Output

### `--output-format text` (Go CLI compatible)

Prints generated migration SQL and the path of the created migration file to stderr.
If `--apply` is set, applies the migration to the local database.
If `--no-apply` is set, writes the migration file and skips the apply step (no prompt); `--no-apply` overrides global `--yes` and cannot be combined with `--apply`.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Requires `--experimental` flag or `[experimental.pgdelta] enabled = true` in `config.toml`.
- `--file` sets the migration filename stem (default: `declarative_sync`); `--name` overrides the full name.
- `--no-cache` forces a fresh shadow database setup, bypassing catalog snapshots.
- `--apply` applies the generated migration to the local database without an interactive prompt.
- `--no-apply` writes the migration only and never applies it or prompts to apply (for CI/agents); mutually exclusive with `--apply`.
