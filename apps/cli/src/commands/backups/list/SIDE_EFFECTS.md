# `supabase backups list`

## Files Read

| Path                                      | Format                    | When                                                                                          |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `/proc/sys/kernel/osrelease` (Linux)      | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)            |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile` |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`    | plain text                | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set                                |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | after the command runs (in `Effect.ensuring`), unless the file already exists, `.temp/project-ref` names a different project, no access token resolves, or the project lookup is not 200 |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command                                                                                                                                          |

## API Routes

| Method | Path                                  | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | ------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/database/backups` | Bearer token | none         | `{region, walg_enabled, pitr_enabled, backups: [{inserted_at, status, is_physical_backup}], physical_backup_data: {earliest_physical_backup_date_unix?, latest_physical_backup_date_unix?}}`                                                             |
| `GET`  | `/v1/projects`                        | Bearer token | none         | `[{id, ref, name, organization_slug, region, ...}]` — TTY-prompt fallback only                                                                                                                                                                           |
| `GET`  | `/v1/projects/{ref}`                  | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — linked-project cache miss only (best-effort, after the command)                                                                                                                                      |
| `GET`  | `/v1/projects/{parent}/branches`      | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                  | Required?                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                     | no (falls back to keyring → `~/.supabase/access-token`)                             |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (used by the cli-e2e test harness). | no (defaults to `supabase`)                                                         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is not given                                                                                                                                                                                                                                  | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY)          |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                        | no (walks up from CWD looking for `supabase/config.toml` or `supabase/config.json`) |

## Exit Codes

| Code | Condition                                                                             |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | success — backup list printed to stdout                                               |
| `1`  | `AccessTokenRequiredError` — no token in env/keyring/file                             |
| `1`  | `InvalidAccessTokenError` — token violates `^sbp_(oauth_\|v0_)?[a-f0-9]{40}$`         |
| `1`  | `ProjectRefNotLinkedError` — no `--remote=<ref>`, env/file empty, and stdin not a TTY |
| `1`  | `InvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                        |
| `1`  | `BackupListUnexpectedStatusError` — non-2xx response from the backups endpoint        |
| `1`  | `BackupListNetworkError` — transport-level network failure                            |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                                                                           |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote=<ref>` → the ref, a bare `--remote` → `true`, any other `--remote` value → `<redacted>`; `--project-ref` → the ref when ref-shaped, else `<redacted>`) |

## Output

The `--output {pretty,json,yaml,toml,env}` flag and the `--output-format {text,json,stream-json}` flag are both honored. `--output` wins when both are supplied. `pretty` and `text` map to the same render path.

### `--output pretty` (default) / `--output-format text`

For PITR-only projects, prints a styled markdown table with columns: `REGION`, `WALG`, `PITR`, `EARLIEST TIMESTAMP`, `LATEST TIMESTAMP`. For projects with logical/physical backups, prints columns: `REGION`, `BACKUP TYPE`, `STATUS`, `CREATED AT (UTC)`.

### `--output json`

Indented JSON (`json.MarshalIndent(resp, "", "  ")` equivalent) of the full backup response, terminated by a newline.

### `--output yaml`

YAML document (CLI-1975): keys are lowercased field names (`walgenabled`,
`physicalbackupdata`), nil values render as explicit `null`, and nested
mappings use 4-column indentation.

### `--output toml`

TOML document (CLI-1975): keys are PascalCase field names (`WalgEnabled`,
`[PhysicalBackupData]`), absent fields are omitted, and sub-tables follow
the primitive keys with 2-space indentation. An empty `backups` array is
omitted entirely.

### `--output env`

`KEY=VALUE` lines (one per leaf), one per line, sorted lexicographically. Keys are flattened with `.` separators then converted to SCREAMING_SNAKE_CASE; values are double-quoted with `"` and `\\` escaped.

### `--output-format json`

Single JSON object emitted via `Output.success` with the full backup response as the `data` field.

### `--output-format stream-json`

One `result` NDJSON event on success containing the backup response object.

## Notes

- Targets the linked project unless `--remote=<ref>` is given; a bare `--remote` also targets the linked project. `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked project (by name or UUID, resolved through `GET /v1/projects/{parent}/branches`), or `true|yes|on|1` for the linked project. A database URL is rejected (`supabase backups list` takes a project, not a database); `false|no|off|0`, `--no-remote` and an empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that is a branch of the linked project fails before any other work with a `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` and prints a deprecation warning on stderr that names the replacement; it cannot be combined with `--remote=<value>`. An empty `--project-ref` is rejected.
- Requires `--remote=<ref>`, `SUPABASE_PROJECT_ID`, a populated `<workdir>/supabase/.temp/project-ref` file, or a TTY for the interactive project picker.
- The interactive picker calls `GET /v1/projects` and writes `"Selected project: <ref>"` to stderr in text mode. It does **not** persist the choice; only `supabase link` and `supabase bootstrap` write the temp file.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers.

- Prints `Target: <project>` once on stderr in every output format, for example `Target: project <name> (<ref>) · production`. `--output-format json|stream-json` object results and error envelopes also carry a `target` object; `--output {json,yaml,toml,env}` payloads are unchanged. Reads never prompt.
