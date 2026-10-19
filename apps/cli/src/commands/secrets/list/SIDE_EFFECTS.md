# `supabase secrets list`

## Files Read

| Path                                      | Format                    | When                                                                                                             |
| ----------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/proc/sys/kernel/osrelease` (Linux)      | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)                               |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile`                    |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                         |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                                    |
| `<workdir>/supabase/.temp/project-ref`    | plain text                | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` are both unset, and as the linked parent for `--remote=<branch>` |

## Files Written

| Path                                             | Format | When                                                         |
| ------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after the project ref resolves |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command              |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | -------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/secrets`     | Bearer token | none         | `[{name, value, updated_at?}]` (value is digest)                                                                                                                                                                                                         |
| `GET`  | `/v1/projects`                   | Bearer token | none         | `[{id, ref, name, ...}]` — TTY-prompt fallback only                                                                                                                                                                                                      |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`              | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                  | Required?                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                     | no (falls back to keyring → `~/.supabase/access-token`)                             |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (used by the cli-e2e test harness). | no (defaults to `supabase`)                                                         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against                                                                                                                                                                | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY)          |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                        | no (walks up from CWD looking for `supabase/config.toml` or `supabase/config.json`) |

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — secrets printed to stdout                                                                                                                                                                                    |
| `1`  | `AccessTokenRequiredError` — no token in env/keyring/file                                                                                                                                                              |
| `1`  | `InvalidAccessTokenError` — token violates `^sbp_(oauth_\|v0_)?[a-f0-9]{40}$`                                                                                                                                          |
| `1`  | `ProjectRefNotLinkedError` — `--remote=<ref>` unset, env/file empty, and stdin not a TTY                                                                                                                               |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |
| `1`  | `InvalidProjectRefError` — a `SUPABASE_PROJECT_ID` or link-file ref violates `^[a-z]{20}$`                                                                                                                             |
| `1`  | `SecretsListUnexpectedStatusError` — non-2xx response from the secrets endpoint                                                                                                                                        |
| `1`  | `SecretsListNetworkError` — transport-level network failure                                                                                                                                                            |
| `1`  | `SecretsEnvNotSupportedError` — `--output env` flag is rejected                                                                                                                                                        |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                              |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` → the ref when ref-shaped, else `<redacted>`) |

## Output

The `--output {pretty,json,yaml,toml,env}` flag and the `--output-format {text,json,stream-json}` flag are both honored. `--output` wins when both are supplied. `pretty` and `text` map to the same render path.

### `--output pretty` (default) / `--output-format text`

Prints a styled markdown table with columns `NAME` and `DIGEST`. Secrets are sorted alphabetically by `name`.

### `--output json`

Indented JSON of the sorted `[{name, value, updated_at?}]` array, terminated by a newline. Field order is alphabetical.

### `--output yaml`

YAML document of the sorted secret array.

### `--output toml`

TOML document wrapping the sorted array as `[[secrets]]` (CLI-1975): PascalCase field names (`Name`, `UpdatedAt`, `Value`), 2-space indentation, fields omitted when absent.

### `--output env`

Fails immediately with `SecretsEnvNotSupportedError("--output env flag is not supported")`.

### `--output-format json`

Single JSON object emitted via `Output.success` with `{secrets: [...]}` as the `data` field, plus a [`target`](../../../../docs/command-target.md) object.

### `--output-format stream-json`

One `result` NDJSON event on success containing `{secrets: [...]}` and `target`.

## Notes

- Prints the `Target:` banner (project name, ref and, for a branch, the parent project) to stderr before the request. It never asks for confirmation, so `--yes` and `SUPABASE_YES` have no effect.
- The `--output {json,yaml,toml}` renderings emit the secret array as-is, without `target`.
- The `value` field returned by the API is a digest/hash of the secret, not the plaintext value.
- Results are sorted alphabetically by `name` before any encoding.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers.
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase secrets list` takes a project, not a database); `false|no|off|0` and `--no-remote` fail with `--remote doesn't take false. Leave it out to use the linked project.`, and an empty value with `--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch>; leave it out to use the linked project.`
- A word after a bare `--remote` is read as its value, `--remote=<word>`, because the command takes
  no operands.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
