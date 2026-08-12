# `supabase secrets set`

## Files Read

| Path                                      | Format                    | When                                                                                                                                                                     |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/proc/sys/kernel/osrelease` (Linux)      | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)                                                                                       |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile`                                                                            |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                                                                                 |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                                                                                            |
| `<workdir>/supabase/.temp/project-ref`    | plain text                | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset                                                                                                            |
| `<workdir>/supabase/config.toml`          | TOML                      | always (for `[edge_runtime.secrets]`) — via `@supabase/config`'s `loadProjectConfig`; a parse failure is logged to the debug logger and tolerated, not fatal |
| `<workdir>/.env`                          | dotenv                    | always — context for `env(VAR)` interpolation in `[edge_runtime.secrets]` values                                                                                         |
| `<workdir>/.env.local`                    | dotenv                    | always — overrides `.env` for `env(VAR)` interpolation context                                                                                                           |
| `<env-file>` (absolute or CWD-relative)   | dotenv                    | when `--env-file` flag is provided                                                                                                                                       |

## Files Written

| Path                                             | Format | When                                                                     |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command              |

## API Routes

| Method | Path                         | Auth         | Request body                           | Response (used fields)   |
| ------ | ---------------------------- | ------------ | -------------------------------------- | ------------------------ |
| `POST` | `/v1/projects/{ref}/secrets` | Bearer token | `[{name: string, value: string}, ...]` | none (201 expected)      |
| `GET`  | `/v1/projects`               | Bearer token | none                                   | TTY-prompt fallback only |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                              | Required?                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                                 | no (falls back to keyring → `~/.supabase/access-token`)                    |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (used by the cli-e2e test harness). | no (defaults to `supabase`)                                                |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset                                                                                                                                                                                                                                                   | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY) |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                                    | no (walks up from CWD looking for `supabase/config.toml`)                  |
| `env(VAR)` references   | values matching `env(NAME)` in `[edge_runtime.secrets]` are resolved against the loaded env. Missing variables preserve the literal verbatim.                                                                                                                                            | —                                                                          |

## Exit Codes

| Code | Condition                                                                                    |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | success — secrets set on the linked project                                                  |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                             |
| `1`  | `LegacyInvalidAccessTokenError` — token violates `^sbp_(oauth_)?[a-f0-9]{40}$`               |
| `1`  | `LegacyProjectNotLinkedError` — `--project-ref` unset, env/file empty, and stdin not a TTY   |
| `1`  | `LegacyInvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                         |
| `1`  | `LegacySecretsNoArgumentsError` — no positional pairs and no entries from env-file or config |
| `1`  | `LegacyInvalidSecretPairError` — positional argument missing `=`                             |
| `1`  | `LegacySecretsEnvFileOpenError` — `--env-file` cannot be opened                              |
| `1`  | `LegacySecretsEnvFileParseError` — `--env-file` cannot be parsed                             |
| `1`  | `LegacySecretsSetUnexpectedStatusError` — non-2xx response from POST                         |
| `1`  | `LegacySecretsSetNetworkError` — transport-level network failure                             |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                         |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` / `--env-file` → `<redacted>`) |

## Output

### `--output pretty` (default) / `--output-format text`

Stdout: `Finished supabase secrets set.\n`. Stderr: one `Env name cannot start with SUPABASE_, skipping: <name>` line per filtered entry.

The `--output {json,yaml,toml,env}` flags all collapse to the same text-mode `Finished` message.

### `--output-format json`

Single JSON object emitted via `Output.success` with `{project_ref, count}` as the `data` field.

### `--output-format stream-json`

One `result` NDJSON event on success containing `{project_ref, count}`.

## Notes

- Source order for merging entries: `[edge_runtime.secrets]` from `config.toml` (only resolved entries — see below) → `--env-file` (overrides config) → CLI args (overrides env-file).
- `SUPABASE_`-prefixed entries are skipped post-merge with a stderr warning.
- `[edge_runtime.secrets]` from config.toml is read via `@supabase/config`'s `loadProjectConfig` + `resolveProjectSubtree`. Resolved secret values arrive wrapped in `Redacted<string>`; unresolved `env(VAR)` literals (env var unset) stay as plain strings and are filtered out at the handler (secrets whose value never resolved past the literal `env(VAR)` form are dropped).
- A malformed `config.toml` does **not** abort the command — the error is logged to the debug logger and the command proceeds. `--env-file` and positional `NAME=VALUE` secrets always still apply. What happens to config-declared secrets depends on the failure class: a raw TOML/JSON syntax error drops everything (no `EdgeRuntime.Secrets`), but a schema-type error on an _unrelated_ field (e.g. `analytics.port` being a string) still leaves a valid `[edge_runtime.secrets]` section usable — the handler recovers it by re-decoding just that subtree. Pass `--debug` to see the logged parse error.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers.
