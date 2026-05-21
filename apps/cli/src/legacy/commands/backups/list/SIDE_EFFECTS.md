# `supabase backups list`

## Files Read

| Path                                      | Format                    | When                                                                                          |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `/proc/sys/kernel/osrelease` (Linux)      | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)            |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`    | plain text                | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset                                 |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                  | Auth         | Request body | Response (used fields)                                                                                                                                                                       |
| ------ | ------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/database/backups` | Bearer token | none         | `{region, walg_enabled, pitr_enabled, backups: [{inserted_at, status, is_physical_backup}], physical_backup_data: {earliest_physical_backup_date_unix?, latest_physical_backup_date_unix?}}` |
| `GET`  | `/v1/projects`                        | Bearer token | none         | `[{id, ref, name, organization_slug, region, ...}]` — TTY-prompt fallback only                                                                                                               |

## Environment Variables

| Variable                | Purpose                                                                                                                                      | Required?                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                         | no (falls back to keyring → `~/.supabase/access-token`)                    |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080` | no (defaults to `supabase`)                                                |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset                                                                                           | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY) |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                            | no (walks up from CWD looking for `supabase/config.toml`)                  |
| ~~`SUPABASE_API_URL`~~  | **not honored** — Go parity. Use `SUPABASE_PROFILE` to override the API base URL.                                                            | —                                                                          |

## Exit Codes

| Code | Condition                                                                                  |
| ---- | ------------------------------------------------------------------------------------------ |
| `0`  | success — backup list printed to stdout                                                    |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                           |
| `1`  | `LegacyInvalidAccessTokenError` — token violates `^sbp_(oauth_)?[a-f0-9]{40}$`             |
| `1`  | `LegacyProjectNotLinkedError` — `--project-ref` unset, env/file empty, and stdin not a TTY |
| `1`  | `LegacyInvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                       |
| `1`  | `LegacyBackupListUnexpectedStatusError` — non-2xx response from the backups endpoint       |
| `1`  | `LegacyBackupListNetworkError` — transport-level network failure                           |

## Output

The legacy `--output {pretty,json,yaml,toml,env}` flag (Go-compatible) and the new global `--output-format {text,json,stream-json}` flag are both honored. `--output` wins when both are supplied. `pretty` and `text` map to the same render path.

### `--output pretty` (Go default) / `--output-format text`

For PITR-only projects, prints a Glamour-styled markdown table with columns: `REGION`, `WALG`, `PITR`, `EARLIEST TIMESTAMP`, `LATEST TIMESTAMP`. For projects with logical/physical backups, prints columns: `REGION`, `BACKUP TYPE`, `STATUS`, `CREATED AT (UTC)`. The table is rendered byte-for-byte to match Go's `glamour.WithStandardStyle(styles.AsciiStyle)` output.

### `--output json` (Go-compat)

Indented JSON (`json.MarshalIndent(resp, "", "  ")` equivalent) of the full backup response, terminated by a newline.

### `--output yaml`

YAML document (`yaml@2` equivalent of Go's `yaml.v3`) of the full backup response.

### `--output toml`

TOML document (`smol-toml` equivalent of Go's `BurntSushi/toml`) of the full backup response. JSON shape is preserved; leaf order may differ from Go.

### `--output env`

`KEY=VALUE` lines (one per leaf), one per line, sorted lexicographically. Keys are flattened with `.` separators then converted to SCREAMING_SNAKE_CASE; values are double-quoted with `"` and `\\` escaped.

### `--output-format json`

Single JSON object emitted via `Output.success` with the full backup response as the `data` field.

### `--output-format stream-json`

One `result` NDJSON event on success containing the backup response object.

## Notes

- Requires `--project-ref`, `SUPABASE_PROJECT_ID`, a populated `<workdir>/supabase/.temp/project-ref` file, or a TTY for the interactive project picker.
- The interactive picker calls `GET /v1/projects` and writes `"Selected project: <ref>"` to stderr in text mode (matches Go `project_ref.go:50`). It does **not** persist the choice; only `supabase link` and `supabase bootstrap` write the temp file.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers — Go parity.
