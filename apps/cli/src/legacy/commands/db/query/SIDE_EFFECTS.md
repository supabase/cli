# `supabase db query`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |
| `<path>` (from `--file`)   | SQL        | when `--file` / `-f` flag is set                  |

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

| Code | Condition                   |
| ---- | --------------------------- |
| `0`  | success                     |
| `1`  | database connection failure |
| `1`  | SQL query error             |

## Output

### `--output-format text` (Go CLI compatible)

Prints query results as a table (default for human mode) or JSON (default for agent mode).

### `--output-format json`

Not applicable (the command has its own `--output` flag for query result format).

### `--output-format stream-json`

Not applicable.

## Notes

- Accepts SQL as a positional argument or via `--file` / `-f`.
- Also reads SQL from stdin when no positional argument or file is given.
- `--output` / `-o` controls query result format: `table`, `json`, or `csv` (default varies by agent mode detection).
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.
- In agent mode, output defaults to JSON with an untrusted data warning envelope.
