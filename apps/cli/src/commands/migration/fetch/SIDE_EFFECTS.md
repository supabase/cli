# `supabase migration fetch`

## Files Read

| Path                                           | Format     | When                                                                                                         |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is the linked project                                      |
| `<workdir>/supabase/.temp/project-ref`         | plain text | linked target (default), to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | linked target, to name the project in the `Target:` banner                                                   |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`  | dotenv     | always, to resolve `SUPABASE_YES` for the overwrite prompt                                                   |

## Files Written

| Path                                                 | Format   | When                                                                                                  |
| ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<version>_<name>.sql` | SQL text | writes fetched migration files locally; the directory is created only after the history table is read |
| `<workdir>/supabase/.temp/linked-project.json`       | JSON     | linked target, on completion — caches the project identity                                            |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                           | Required?                                                                                               |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for the linked target  | no (falls back to keyring → `~/.supabase/access-token`)                                                 |
| `SUPABASE_YES`          | auto-confirm the overwrite prompt | no — read from the shell env OR the project `.env`/`.env.local`/`.env.<env>[.local]` files (shell wins) |

## Exit Codes

| Code | Condition                            |
| ---- | ------------------------------------ |
| `0`  | success                              |
| `1`  | database connection failure          |
| `1`  | failed to write migration files      |
| `1`  | conflicting target flags (see Notes) |

## Output

### `--output-format text`

Prints one `Target: …` line on stderr naming the resolved database, then is silent on success. Reads
`SELECT version, coalesce(name, '') as name, statements FROM
supabase_migrations.schema_migrations` and writes each row to
`<workdir>/supabase/migrations/<version>_<name>.sql` (statements joined with
`;\n` plus a trailing `;\n`, mode 0644).

### `--output-format json`

Emits `output.success("Migration history fetched", { files: [<absolute path>] })`, with the resolved `target` merged in.

### `--output-format stream-json`

Same structured `files` result delivered as an NDJSON `result` event.

## Prompts

- When the migrations directory is non-empty, prompts
  `Do you want to overwrite existing files in supabase/migrations directory?`
  (default **YES**). Declining exits non-zero (`context canceled`). `--yes` or
  `SUPABASE_YES` (shell env or project `.env`) auto-confirms; a non-interactive /
  machine-output run takes the default (YES). An unrecognised answer declines. This is a
  prompt about local files, so a `SUPABASE_YES` in the project `.env` still answers it.
- The command only reads the remote history, so it asks for no hosted-mutation consent.
  `--yes` (or a shell `SUPABASE_YES`) additionally lets the connection remove a network ban
  that blocks the temporary login role.

## Notes

- The default target is the linked project; `--local` selects the local database and `--db-url`
  selects another database. `--local`, `--linked` and `--db-url` are mutually exclusive.
- **`--project-ref`** selects a linked project (flag > `SUPABASE_PROJECT_ID` >
  `.temp/project-ref`) and implies `--linked`. Combining it with `--local` or `--db-url` is
  a hard error.
- Fetches migration file contents from the `supabase_migrations.schema_migrations` history table.
- **Empty-statements rows:** a row whose `statements` array is empty
  (NULL/`{}` — possible on older projects or manually-inserted rows) is written as
  exactly `;\n`, not an empty file.
- **Path-traversal hardening :** before writing, each row's `version`/`name`
  is validated (`version` is all digits; `name` has no `/`, `\`, or `..` segment).
  A tampered/hostile remote could otherwise supply separators to escape the
  migrations directory (CWE-22). This is a new check with no effect on legitimate
  rows (real versions are digits and names are sanitized file stems); it
  fails with `failed to write migration: invalid version/name in history table`.
