# `supabase secrets unset`

## Files Read

| Path                                      | Format                    | When                                                                                          |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `/proc/sys/kernel/osrelease` (Linux)      | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)            |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile` |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`    | plain text                | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset                                 |

## Files Written

| Path                                             | Format | When                                                         |
| ------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command              |

## API Routes

| Method   | Path                         | Auth         | Request body    | Response (used fields)                                     |
| -------- | ---------------------------- | ------------ | --------------- | ---------------------------------------------------------- |
| `GET`    | `/v1/projects/{ref}/secrets` | Bearer token | none            | `[{name}]` — `--all` path only, filters `SUPABASE_` prefix |
| `DELETE` | `/v1/projects/{ref}/secrets` | Bearer token | `["NAME", ...]` | none (200 expected; not called with `--dry-run`)           |
| `GET`    | `/v1/projects`               | Bearer token | none            | TTY-prompt fallback only                                   |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                  | Required?                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                     | no (falls back to keyring → `~/.supabase/access-token`)                             |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (used by the cli-e2e test harness). | no (defaults to `supabase`)                                                         |
| `SUPABASE_YES`          | confirms without a prompt, same as `--yes`                                                                                                                                                                                                                                               | no                                                                                  |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset                                                                                                                                                                                                                                       | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY)          |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                        | no (walks up from CWD looking for `supabase/config.toml` or `supabase/config.json`) |

## Exit Codes

| Code | Condition                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — secrets unset from the linked project                                                                                           |
| `0`  | `--dry-run` — the secrets that would be unset were printed, no DELETE call                                                                |
| `0`  | `--all` resolved to zero non-`SUPABASE_` secrets (no DELETE call; text writes the stderr no-op, machine formats an empty result)          |
| `1`  | `SecretsNoArgumentsError` — no names and no `--all`; fails before the project ref resolves and before any API call                        |
| `1`  | `SecretsUnsetInputError` — names given together with `--all`; fails before the project ref resolves and before any API call               |
| `1`  | `AccessTokenRequiredError` — no token in env/keyring/file                                                                                 |
| `1`  | `InvalidAccessTokenError` — token violates `^sbp_(oauth_\|v0_)?[a-f0-9]{40}$`                                                             |
| `1`  | `ProjectRefNotLinkedError` — `--project-ref` unset, env/file empty, and stdin not a TTY                                                   |
| `1`  | `InvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                                                                            |
| `1`  | `SecretsUnsetConfirmationRequiredError` — no `--yes`/`SUPABASE_YES` and stdin is not a TTY or output is not interactive text; no API call |
| `1`  | `SecretsListUnexpectedStatusError` — non-2xx response from GET (`--all` path)                                                             |
| `1`  | `SecretsListNetworkError` — GET transport failure (`--all` path)                                                                          |
| `1`  | `SecretsUnsetCancelledError` — user declined the confirmation prompt                                                                      |
| `1`  | `SecretsUnsetUnexpectedStatusError` — non-2xx response from DELETE                                                                        |
| `1`  | `SecretsUnsetNetworkError` — DELETE transport failure                                                                                     |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                          |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`) |

## Output

### `--output pretty` (default) / `--output-format text`

Stdout: `Finished supabase secrets unset.\n`. Stderr: the confirmation prompt (`Do you want to unset these function secrets from project <ref>?`, the bulleted names, then `[y/N]`; default No) on an interactive TTY without `--yes`, the same label with `[y/N] y` echoed with `--yes`, or the no-op message when `--all` resolves to no secrets.

`--dry-run` stdout, with no `Finished` line and no prompt:

```
Would unset these function secrets from project <ref>:
 • NAME_A
 • NAME_B
```

The `--output {json,yaml,toml,env}` flags all collapse to the same text-mode output.

### `--output-format json`

Single JSON object emitted via `Output.success` with `{project_ref, count, names, dry_run: false}` as the `data` field.

With `--dry-run`, the message is `Dry run: no secrets were unset.` and `data` is `{project_ref, count, names, dry_run: true}`.

When `--all` resolves to no secrets, the message is `You have not set any function secrets, nothing to do.` and `data` is `{project_ref, count: 0, names: [], dry_run}`.

### `--output-format stream-json`

One `result` NDJSON event on success containing `{project_ref, count, names, dry_run}`, with the same `--dry-run` and empty-`--all` messages as `json`.

## Notes

- Names and `--all` are mutually exclusive; with neither, the command fails. `--all` unsets every secret that does not have a `SUPABASE_` prefix.
- Argument validation runs before the project ref resolves, so a usage error never opens the project picker and makes no API call.
- The prompt defaults to No and names the project ref. `--yes` (or `SUPABASE_YES`) skips the prompt with a stderr label echo.
- Without `--yes`, a run whose stdin is not a TTY, or whose output is not interactive text (`json`, `stream-json`), fails before any API call. Piped stdin answers are not read.
- `--dry-run` never prompts, never calls DELETE, and works without `--yes` in every output mode. With `--all` it still calls GET to list the secrets.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers.
