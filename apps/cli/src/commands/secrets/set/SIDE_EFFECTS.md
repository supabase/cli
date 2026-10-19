# `supabase secrets set`

## Files Read

| Path                                              | Format                    | When                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/proc/sys/kernel/osrelease` (Linux)              | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)                                                                                                                                              |
| keyring `"Supabase CLI"` / `<profile>`            | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile`                                                                                                                                   |
| keyring `"Supabase CLI"` / `access-token`         | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                                                                                                                                        |
| `~/.supabase/access-token`                        | plain text (token string) | last-resort fallback after env + keyring miss                                                                                                                                                                                   |
| `<workdir>/supabase/.temp/project-ref`            | plain text                | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` are both unset, and as the linked parent for `--remote=<branch>`                                                                                                                |
| `<workdir>/supabase/.temp/linked-project.json`    | JSON                      | existence check before the cache fill (in `Effect.ensuring` after the project ref resolves)                                                                                                                                     |
| `<workdir>/supabase/config.json` or `config.toml` | JSON / TOML               | always (for `[edge_runtime.secrets]`, `config.json` preferred) — via the `CliConfigValues` resolved config, with a matching `[remotes.*]` block applied; a parse failure is debug-logged and tolerated, a removed key is fatal. |
| `<workdir>/.env*`, `<workdir>/supabase/.env*`     | dotenv                    | always — project env files selected by `SUPABASE_ENV` (default `development`), context for `env(VAR)` interpolation in `[edge_runtime.secrets]` values; a variable the shell sets is never taken from a file                    |
| `<env-file>` (absolute or CWD-relative)           | dotenv                    | when `--env-file` flag is provided                                                                                                                                                                                              |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                              |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | in `Effect.ensuring` after the project ref resolves — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command                                                                                                                                                   |

## API Routes

| Method | Path                             | Auth         | Request body                           | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | -------------------------------- | ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/projects/{ref}/secrets`     | Bearer token | `[{name: string, value: string}, ...]` | none (201 expected)                                                                                                                                                                                                                                      |
| `GET`  | `/v1/projects`                   | Bearer token | none                                   | project picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, stdin is a TTY and output is interactive                                                                                                    |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none                                   | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/projects/{ref}`             | Bearer token | none                                   | linked-project cache fill — best-effort, only when `.temp/linked-project.json` is absent, `.temp/project-ref` is absent or names the same ref, and a token is available; failures are ignored                                                            |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                  | Required?                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                     | no (falls back to keyring → `~/.supabase/access-token`)                             |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (used by the cli-e2e test harness). | no (defaults to `supabase`)                                                         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against                                                                                                                                                                | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY)          |
| `SUPABASE_YES`          | confirms the set without a prompt, same as `--yes`; read from the shell only (a project `.env` value does not count)                                                                                                                                                                     |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                        | no (walks up from CWD looking for `supabase/config.toml` or `supabase/config.json`) |
| `env(VAR)` references   | values matching `env(NAME)` in `[edge_runtime.secrets]` are resolved against the loaded env. Missing variables preserve the literal verbatim.                                                                                                                                            | —                                                                                   |

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — secrets set on the linked project                                                                                                                                                                            |
| `1`  | `AccessTokenRequiredError` — no token in env/keyring/file                                                                                                                                                              |
| `1`  | `InvalidAccessTokenError` — token violates `^sbp_(oauth_\|v0_)?[a-f0-9]{40}$`                                                                                                                                          |
| `1`  | `ProjectRefNotLinkedError` — `--remote=<ref>` unset, env/file empty, and stdin not a TTY                                                                                                                               |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |
| `1`  | `InvalidProjectRefError` — a `SUPABASE_PROJECT_ID` or link-file ref violates `^[a-z]{20}$`                                                                                                                             |
| `1`  | `SecretsNoArgumentsError` — no positional pairs and no entries from env-file or config                                                                                                                                 |
| `1`  | `InvalidSecretPairError` — positional argument missing `=`                                                                                                                                                             |
| `1`  | `SecretsEnvFileOpenError` — `--env-file` cannot be opened                                                                                                                                                              |
| `1`  | `SecretsEnvFileParseError` — `--env-file` cannot be parsed                                                                                                                                                             |
| `1`  | `HostedMutationDeclinedError` — the confirmation was declined; nothing is sent                                                                                                                                         |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes`/shell `SUPABASE_YES` on a non-interactive or machine-output run; nothing is sent                                                                                     |
| `1`  | `SecretsSetUnexpectedStatusError` — non-2xx response from POST                                                                                                                                                         |
| `1`  | `SecretsSetNetworkError` — transport-level network failure                                                                                                                                                             |
| `1`  | `CliConfigRemovedKeyError` — config uses a removed key, named with its replacement                                                                                                                                     |
| `1`  | `CliConfigRemovedEnvError` — non-empty `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION` set                                                                                                                                    |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                                                           |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` → the ref when ref-shaped, else `<redacted>`; `--env-file` → `<redacted>`) |

## Output

### `--output pretty` (default) / `--output-format text`

Stdout: `Finished supabase secrets set.\n`. Stderr: the `Target:` banner, one `Env name cannot start with SUPABASE_, skipping: <name>` line per filtered entry, then either the confirmation (`Secrets to set:` with the bulleted names, then `Set N secret(s) on <target>?`, default No) on an interactive terminal or `Confirmed by --yes: Set N secret(s) on <target>` under `--yes`. Secret values are never printed.

The `--output {json,yaml,toml,env}` flags all collapse to the same text-mode `Finished` message.

### `--output-format json`

Single JSON object emitted via `Output.success` with `{project_ref, count}` as the `data` field, plus a [`target`](../../../../docs/command-target.md) object. Needs `--yes` or a shell `SUPABASE_YES`, because machine output never prompts.

### `--output-format stream-json`

One `result` NDJSON event on success containing `{project_ref, count}` and `target`. Needs `--yes` or a shell `SUPABASE_YES`.

## Notes

- Asks one question before the first POST: `set N secret(s)` on the announced target, default No, listing the secret names (never values). It runs after the entries are merged, so a usage or parse error never prompts, and a decline sends nothing.
- `--yes` or a `SUPABASE_YES` set in the shell skips the question. A `SUPABASE_YES` in a project `.env*` file does not count, and piped stdin answers are never read.
- Source order for merging entries: `[edge_runtime.secrets]` from `config.toml` (only resolved entries — see below) → `--env-file` (overrides config) → CLI args (overrides env-file).
- `SUPABASE_`-prefixed entries are skipped post-merge with a stderr warning.
- Secrets are POSTed in batches of 100 (the API's per-request cap); every batch is validated before the first POST. When no secrets remain after filtering, the command fails with `SecretsNoArgumentsError` and makes no POST (the cache fill still runs).
- `[edge_runtime.secrets]` from config.toml is read through the `CliConfigValues` resolved config (shell env > project `.env*` > config for `env(VAR)` references) + `resolveCliSubtree`. Resolved secret values arrive wrapped in `Redacted<string>`; unresolved `env(VAR)` literals (env var unset) stay as plain strings and are filtered out at the handler (secrets whose value never resolved past the literal `env(VAR)` form are dropped).
- A removed config key or a non-empty `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION` **does** abort the command (exit 1, before any request) instead of being tolerated: silently dropping the config's `[edge_runtime.secrets]` would send a partial secret set.
- A malformed `config.toml` does **not** abort the command — the error is logged to the debug logger and the command proceeds. `--env-file` and positional `NAME=VALUE` secrets always still apply. What happens to config-declared secrets depends on the failure class: a raw TOML/JSON syntax error drops everything (no `EdgeRuntime.Secrets`), but a schema-type error on an _unrelated_ field (e.g. `analytics.port` being a string) still leaves a valid `[edge_runtime.secrets]` section usable — the handler recovers it by re-decoding just that subtree. Pass `--debug` to see the logged parse error.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers.
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase secrets set` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that exactly matches a branch of the linked project, is
  within a small edit distance of one, or can't be checked because the branch listing failed stops
  the run before any other work with an error that offers both readings: `--remote=<word>` for the
  branch, `<word> --remote` for the operand. Any other word runs as the operand.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
