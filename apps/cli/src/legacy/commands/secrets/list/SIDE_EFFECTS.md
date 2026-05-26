# `supabase secrets list`

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

| Method | Path                         | Auth         | Request body | Response (used fields)                              |
| ------ | ---------------------------- | ------------ | ------------ | --------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/secrets` | Bearer token | none         | `[{name, value, updated_at?}]` (value is digest)    |
| `GET`  | `/v1/projects`               | Bearer token | none         | `[{id, ref, name, ...}]` — TTY-prompt fallback only |

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
| `0`  | success — secrets printed to stdout                                                        |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                           |
| `1`  | `LegacyInvalidAccessTokenError` — token violates `^sbp_(oauth_)?[a-f0-9]{40}$`             |
| `1`  | `LegacyProjectNotLinkedError` — `--project-ref` unset, env/file empty, and stdin not a TTY |
| `1`  | `LegacyInvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                       |
| `1`  | `LegacySecretsListUnexpectedStatusError` — non-2xx response from the secrets endpoint      |
| `1`  | `LegacySecretsListNetworkError` — transport-level network failure                          |
| `1`  | `LegacySecretsEnvNotSupportedError` — `--output env` flag is rejected                      |

## Output

The legacy `--output {pretty,json,yaml,toml,env}` flag (Go-compatible) and the new global `--output-format {text,json,stream-json}` flag are both honored. `--output` wins when both are supplied. `pretty` and `text` map to the same render path.

### `--output pretty` (Go default) / `--output-format text`

Prints a Glamour-styled markdown table with columns `NAME` and `DIGEST`. The table is rendered byte-for-byte to match Go's `glamour.WithStandardStyle(styles.AsciiStyle)` output (verified against the Go binary fixture). Secrets are sorted alphabetically by `name`.

### `--output json` (Go-compat)

Indented JSON of the sorted `[{name, value, updated_at?}]` array, terminated by a newline. Field order is alphabetical (matches Go's struct declaration order for `SecretResponse`).

### `--output yaml`

YAML document of the sorted secret array.

### `--output toml`

TOML document wrapping the sorted array as `[[secrets]]`. JSON shape is preserved; leaf order may differ from Go's `BurntSushi/toml` encoder.

### `--output env`

Fails immediately with `LegacySecretsEnvNotSupportedError("--output env flag is not supported")` — Go parity.

### `--output-format json`

Single JSON object emitted via `Output.success` with `{secrets: [...]}` as the `data` field.

### `--output-format stream-json`

One `result` NDJSON event on success containing `{secrets: [...]}`.

## Notes

- The `value` field returned by the API is a digest/hash of the secret, not the plaintext value.
- Results are sorted alphabetically by `name` before any encoding (Go `list.go:52-54`).
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers — Go parity.
