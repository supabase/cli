# `supabase branches list`

## Files Read

| Path                                      | Format                    | When                                                                                          |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`    | plain text                | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset                                 |

## Files Written

| Path                                             | Format | When                                                                     |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves — Go parity |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command — Go parity              |

## API Routes

| Method | Path                          | Auth         | Request body | Response (used fields)                                                                                                               |
| ------ | ----------------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/branches` | Bearer token | none         | `[{id, name, project_ref, parent_project_ref, is_default, git_branch?, persistent, status, created_at, updated_at, with_data, ...}]` |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                              | Required?                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                                 | no (falls back to keyring → `~/.supabase/access-token`)                    |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (Go parity — used by the cli-e2e test harness). | no (defaults to `supabase`)                                                |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset                                                                                                                                                                                                                                                   | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY) |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                                    | no (walks up from CWD looking for `supabase/config.toml`)                  |

## Exit Codes

| Code | Condition                                                                       |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | success — branches printed to stdout                                            |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                |
| `1`  | `LegacyProjectNotLinkedError` — `--project-ref` unset, env/file empty, non-TTY  |
| `1`  | `LegacyInvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`            |
| `1`  | `LegacyBranchesListUnexpectedStatusError` — non-2xx response from list endpoint |
| `1`  | `LegacyBranchesListNetworkError` — transport-level network failure              |
| `1`  | `LegacyBranchesEnvNotSupportedError` — `--output env` flag is rejected          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                       |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` whitelisted) |

Matches `apps/cli-go/internal/branches/list/`. Go does not fire any custom telemetry event for this command.

## Output

The legacy `--output {pretty,json,yaml,toml,env}` flag (Go-compatible) and the new global `--output-format {text,json,stream-json}` flag are both honored. `--output` wins when both are supplied. `pretty` and `text` map to the same Glamour render.

### `--output pretty` (Go default) / `--output-format text`

Prints a Glamour-styled markdown table with columns `ID`, `NAME`, `DEFAULT`, `GIT BRANCH`, `WITH DATA`, `STATUS`, `CREATED AT (UTC)`, `UPDATED AT (UTC)`. Byte-matched against the Go CLI.

### `--output json` (Go-compat)

Indented JSON of the `BranchResponse[]` array with alphabetical keys + trailing newline.

### `--output yaml`

YAML document of the branch array.

### `--output toml`

TOML document wrapping the array as `[[branches]]` (Go parity).

### `--output env`

Fails with `LegacyBranchesEnvNotSupportedError("--output env flag is not supported")`.

### `--output-format json`

Single JSON object via `Output.success` with `{branches: [...]}` data.

### `--output-format stream-json`

One `result` NDJSON event with `{branches: [...]}`.

## Notes

- Reads timestamp formatting follows Go's `utils.FormatTime` (UTC `YYYY-MM-DD HH:MM:SS`).
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers.
