# `supabase migration list`

## Files Read

| Path                                   | Format     | When                                                                                                      |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked`                                                         |
| `<workdir>/supabase/.temp/project-ref` | plain text | `--linked` (default), to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |
| `<workdir>/supabase/migrations/`       | directory  | always, to list local migration files                                                                     |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                                                                                                                  | Required?                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode                                                                                           | no (falls back to keyring → `~/.supabase/access-token`)      |
| `DB_PASSWORD`           | password for direct database connection                                                                                  | no                                                           |
| `SUPABASE_TARGET`       | workspace target (`local` or `remote`) used when no selector flag is given; overrides `target` in `supabase/config.toml` | no (falls back to config `target`, then the command default) |

## Target selection

With no `--local`, `--linked`, `--db-url` or `--project-ref` flag, the command follows the workspace target: `SUPABASE_TARGET` (`local` or `remote`;
shell environment first, then `supabase/.env*`), then `target` in `supabase/config.toml` (or
`config.json`). `remote` targets the linked project through the existing linked path; `local`
targets the local database. An explicit selector flag always wins over the target. An invalid
`SUPABASE_TARGET` or `target` value exits `1` with `WorkspaceTargetError`. Config is only read for
the target when no selector flag is given; an unreadable config counts as unset.

When neither is set the command keeps targeting the linked project and writes one warning to
**stderr** (every `--output-format`, never stdout), so scripts depending on today's default keep
working while the next major version moves it to the local database:

```
Warning: supabase migration list will target the local database by default in the next major version. Pass --linked, or set target = "remote" in supabase/config.toml (or SUPABASE_TARGET=remote), to keep targeting the linked project.
```

No warning is written when a selector flag, `--project-ref`, `SUPABASE_TARGET` or `target` is set.

## Exit Codes

| Code | Condition                                                                |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success                                                                  |
| `1`  | database connection failure                                              |
| `1`  | failed to open migrations directory                                      |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes) |

## Output

### `--output-format text`

Prints a Glamour ASCII table `|Local|Remote|Time (UTC)|` to stdout (`AsciiStyle`
rendering; cells are backtick-wrapped inline code). Queries `SELECT version FROM
supabase_migrations.schema_migrations ORDER BY version` (a missing table → empty
Remote column).

### `--output-format json`

Emits `output.success("Migrations listed", { migrations: [{ local, remote, time }] })`.
`local`/`remote` are empty strings when a version exists only on the other side.

### `--output-format stream-json`

Same structured `migrations` result delivered as an NDJSON `result` event.

## Notes

- `--linked` (default true) lists migrations from the linked project via direct DB connection.
- `--local` lists migrations applied to the local database.
- `--db-url` targets a specific database URL directly.
- `--password` / `-p` sets the DB password (also reads `DB_PASSWORD` env var).
- `--db-url`, `--linked`, and `--local` are mutually exclusive.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing command)
  overrides ONLY the linked-ref resolution used for the connection (flag >
  `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies `--linked`:
  passing it with a resolved `--local`/`--db-url` target is a hard error rather
  than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which Go's equivalent env var simply leaves unused on
  a non-linked target).
