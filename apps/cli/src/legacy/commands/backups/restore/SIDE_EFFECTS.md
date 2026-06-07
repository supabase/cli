# `supabase backups restore`

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

| Method | Path                                               | Auth         | Request body                         | Response (used fields)                                                         |
| ------ | -------------------------------------------------- | ------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| `POST` | `/v1/projects/{ref}/database/backups/restore-pitr` | Bearer token | `{recovery_time_target_unix: int64}` | none (201 Created)                                                             |
| `GET`  | `/v1/projects`                                     | Bearer token | none                                 | `[{id, ref, name, organization_slug, region, ...}]` — TTY-prompt fallback only |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                              | Required?                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                                 | no (falls back to keyring → `~/.supabase/access-token`)                    |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (Go parity — used by the cli-e2e test harness). | no (defaults to `supabase`)                                                |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset                                                                                                                                                                                                                                                   | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY) |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                                    | no (walks up from CWD looking for `supabase/config.toml`)                  |
| ~~`SUPABASE_API_URL`~~  | **not honored** — Go parity. Use `SUPABASE_PROFILE` to override the API base URL.                                                                                                                                                                                                                    | —                                                                          |

## Exit Codes

| Code | Condition                                                                                  |
| ---- | ------------------------------------------------------------------------------------------ |
| `0`  | success — restore initiated                                                                |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                           |
| `1`  | `LegacyInvalidAccessTokenError` — token violates `^sbp_(oauth_)?[a-f0-9]{40}$`             |
| `1`  | `LegacyProjectNotLinkedError` — `--project-ref` unset, env/file empty, and stdin not a TTY |
| `1`  | `LegacyInvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                       |
| `1`  | `LegacyBackupRestoreUnexpectedStatusError` — non-201 response from the restore endpoint    |
| `1`  | `LegacyBackupRestoreNetworkError` — transport-level network failure                        |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                          |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` / `--timestamp` → `<redacted>`) |

Matches `apps/cli-go/internal/backups/restore/`. Go does not fire any custom telemetry event for this command.

## Output

Go's `restore` command ignores `--output` entirely (`apps/cli-go/internal/backups/restore/restore.go:22`) and always writes the success line to **stderr**. The legacy port mirrors that for every Go `--output` value. The `--output-format` (TS-only) JSON modes get a structured payload — non-breaking because Go has no JSON for restore.

### `--output pretty|yaml|toml|env` (Go-compat) / `--output-format text`

Writes `"Started PITR restore: <ref>\n"` to **stderr** (byte-identical to Go).

### `--output json` (Go-compat)

Indented JSON object on stdout: `{ "message": "Started PITR restore", "project_ref": "<ref>" }`.

### `--output-format json`

Single JSON success event via `Output.success("Started PITR restore", { project_ref })`.

### `--output-format stream-json`

One `result` NDJSON event on success with the project ref payload.

## Notes

- `--timestamp` / `-t` accepts seconds since Unix epoch (int64). Defaults to `0`, which the API interprets as "now".
- Known Go-parity gap: the generated `V1RestorePitrBackupInput` schema enforces `recovery_time_target_unix >= 0`. Go's `int64` has no lower bound, so a negative value is rejected locally with a schema decode error instead of being forwarded to the API. Resolving this requires an upstream OpenAPI spec change.
- Requires `--project-ref`, `SUPABASE_PROJECT_ID`, a populated `<workdir>/supabase/.temp/project-ref` file, or a TTY for the interactive project picker.
- The interactive picker calls `GET /v1/projects` and writes `"Selected project: <ref>"` to stderr in text mode (matches Go `project_ref.go:50`). It does **not** persist the choice; only `supabase link` and `supabase bootstrap` write the temp file.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers — Go parity.
