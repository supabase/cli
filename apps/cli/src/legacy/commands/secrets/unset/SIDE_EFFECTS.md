# `supabase secrets unset`

## Files Read

| Path                                      | Format                    | When                                                                                          |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `/proc/sys/kernel/osrelease` (Linux)      | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)            |
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

| Method   | Path                         | Auth         | Request body    | Response (used fields)                                        |
| -------- | ---------------------------- | ------------ | --------------- | ------------------------------------------------------------- |
| `GET`    | `/v1/projects/{ref}/secrets` | Bearer token | none            | `[{name}]` — empty-args path only, filters `SUPABASE_` prefix |
| `DELETE` | `/v1/projects/{ref}/secrets` | Bearer token | `["NAME", ...]` | none (200 expected)                                           |
| `GET`    | `/v1/projects`               | Bearer token | none            | TTY-prompt fallback only                                      |

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
| `0`  | success — secrets unset from the linked project                                            |
| `0`  | empty-args path resolved to zero non-`SUPABASE_` secrets (stderr no-op, no DELETE call)    |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                           |
| `1`  | `LegacyInvalidAccessTokenError` — token violates `^sbp_(oauth_)?[a-f0-9]{40}$`             |
| `1`  | `LegacyProjectNotLinkedError` — `--project-ref` unset, env/file empty, and stdin not a TTY |
| `1`  | `LegacyInvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                       |
| `1`  | `LegacySecretsListUnexpectedStatusError` — non-2xx response from GET (empty-args path)     |
| `1`  | `LegacySecretsListNetworkError` — GET transport failure (empty-args path)                  |
| `1`  | `LegacySecretsUnsetCancelledError` — user declined the confirmation prompt                 |
| `1`  | `LegacySecretsUnsetUnexpectedStatusError` — non-2xx response from DELETE                   |
| `1`  | `LegacySecretsUnsetNetworkError` — DELETE transport failure                                |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                          |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`) |

Matches `apps/cli-go/internal/secrets/unset/`. Go does not fire any custom telemetry event for this command.

## Output

### `--output pretty` (Go default) / `--output-format text`

Stdout: `Finished supabase secrets unset.\n`. Stderr: confirmation prompt label (when TTY without `--yes`) or `[Y/n] y` echo (with `--yes`) or the no-op message when empty-args resolves to no secrets.

Go's `--output {json,yaml,toml,env}` flags all collapse to the same text-mode `Finished` message.

### `--output-format json`

Single JSON object emitted via `Output.success` with `{project_ref, count}` as the `data` field.

### `--output-format stream-json`

One `result` NDJSON event on success containing `{project_ref, count}`.

## Notes

- When called without arguments, fetches the full secret list and unsets all entries that do not have a `SUPABASE_` prefix.
- `--yes` bypasses the confirmation prompt with a stderr label echo.
- Non-TTY without `--yes` auto-confirms silently — matches Go's `PromptYesNo` (`apps/cli-go/internal/utils/console.go`), which defaults to true after a 100ms non-TTY read timeout.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers — Go parity.
