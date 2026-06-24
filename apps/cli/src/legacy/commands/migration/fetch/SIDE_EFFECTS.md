# `supabase migration fetch`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

## Files Written

| Path                                                 | Format   | When                                            |
| ---------------------------------------------------- | -------- | ----------------------------------------------- |
| `<workdir>/supabase/migrations/<version>_<name>.sql` | SQL text | always — writes fetched migration files locally |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                        | Required?                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode | no (falls back to keyring → `~/.supabase/access-token`) |

## Exit Codes

| Code | Condition                       |
| ---- | ------------------------------- |
| `0`  | success                         |
| `1`  | database connection failure     |
| `1`  | failed to write migration files |

## Output

### `--output-format text` (Go CLI compatible)

Silent on success (Go prints nothing). Reads
`SELECT version, coalesce(name, '') as name, statements FROM
supabase_migrations.schema_migrations` and writes each row to
`<workdir>/supabase/migrations/<version>_<name>.sql` (statements joined with
`;\n` plus a trailing `;\n`, mode 0644).

### `--output-format json`

Emits `output.success("Migration history fetched", { files: [<absolute path>] })`.

### `--output-format stream-json`

Same structured `files` result delivered as an NDJSON `result` event.

## Prompts

- When the migrations directory is non-empty, prompts
  `Do you want to overwrite existing files in supabase/migrations directory?`
  (default **YES**). Declining exits non-zero (`context canceled`). `--yes`
  auto-confirms; a non-interactive / machine-output run takes the default (YES).

## Notes

- `--linked` (default true), `--local`, and `--db-url` are mutually exclusive.
- Fetches migration file contents from the `supabase_migrations.schema_migrations` history table.
- **Empty-statements rows (Go parity):** a row whose `statements` array is empty
  (NULL/`{}` — possible on older projects or manually-inserted rows) is written as
  exactly `;\n`, because Go does `strings.Join(statements, ";\n") + ";\n"`. The port
  reproduces these bytes verbatim rather than emitting an empty file; changing this
  would be a deliberate divergence from the Go CLI.
- **Path-traversal hardening (TS-only):** before writing, each row's `version`/`name`
  is validated (`version` is all digits; `name` has no `/`, `\`, or `..` segment).
  A tampered/hostile remote could otherwise supply separators to escape the
  migrations directory (CWE-22). Go has no such check; the guard is parity-neutral
  for legitimate rows (real versions are digits and names are sanitized file stems)
  and fails with `failed to write migration: invalid version/name in history table`.
