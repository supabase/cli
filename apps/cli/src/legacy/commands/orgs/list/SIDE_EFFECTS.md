# `supabase orgs list`

## Files Read

| Path                                      | Format                    | When                                                                                          |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                 |

## Files Written

| Path                         | Format | When                                                        |
| ---------------------------- | ------ | ----------------------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always (in `Effect.ensuring`) at end of command — Go parity |

`orgs list` is a user-level command — it does not resolve a `--project-ref`, so the legacy
linked-project cache (`~/.supabase/<workdir-hash>/linked-project.json`) is never written.

## API Routes

| Method | Path                | Auth         | Request body | Response (used fields)                       |
| ------ | ------------------- | ------------ | ------------ | -------------------------------------------- |
| `GET`  | `/v1/organizations` | Bearer token | none         | `[{id: string, slug: string, name: string}]` |

## Environment Variables

| Variable                | Purpose                                                                                                                                                   | Required?                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                      | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | selects API base URL (`supabase`, `supabase-staging`, `supabase-local`), or a filesystem path to a YAML profile (Go parity — used by the cli-e2e harness) | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                                   |
| ---- | --------------------------------------------------------------------------- |
| `0`  | success — organizations printed to stdout                                   |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file            |
| `1`  | `LegacyOrgsListUnexpectedStatusError` — non-2xx response from list endpoint |
| `1`  | `LegacyOrgsListNetworkError` — transport-level network failure              |
| `1`  | `LegacyOrgsEnvNotSupportedError` — `--output env` flag is rejected          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

Matches `apps/cli-go/internal/orgs/list/`. Go does not fire any custom telemetry event for this
command.

## Output

The legacy `--output {pretty,json,yaml,toml,env}` flag (Go-compatible) and the new global
`--output-format {text,json,stream-json}` flag are both honored. `--output` wins when both
are supplied. `pretty` and `text` map to the same Glamour render.

### `--output pretty` (Go default) / `--output-format text`

Prints a Glamour-styled markdown table with columns `ID`, `NAME`. Byte-matched against the
Go CLI. The rendered table always ends with a trailing newline (Glamour appends one).

### `--output json` (Go-compat)

Indented JSON of the `OrganizationResponseV1[]` array with alphabetical keys + trailing newline.

### `--output yaml`

YAML document of the organizations array.

### `--output toml`

TOML document wrapping the array as `[[organizations]]` (Go parity).

### `--output env`

Fails with `LegacyOrgsEnvNotSupportedError("--output env flag is not supported")`. Matches
`apps/cli-go/internal/orgs/list/list.go:32-33`.

### `--output-format json`

Single JSON object via `Output.success` with `{organizations: [...]}` data.

### `--output-format stream-json`

One `result` NDJSON event with `{organizations: [...]}`.

## Notes

- No `--project-ref` flag. The result set is determined entirely by the access token's scope.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth.

## Security Notes

- API-supplied `id` and `name` strings are rendered to stdout without ANSI / control-character
  sanitization. This is strict Go parity — the Go CLI uses `glamour` which has the same
  pass-through behaviour. A malicious or compromised Management API could in principle return
  org names containing terminal escape sequences. If sanitization is added later it should
  land at the renderer (`legacy-glamour-table.ts`) so both shells inherit the fix.
- Error response bodies embedded in `LegacyOrgsListUnexpectedStatusError` are sanitized by
  `mapLegacyHttpError` (control chars stripped, capped at 1024 bytes).
