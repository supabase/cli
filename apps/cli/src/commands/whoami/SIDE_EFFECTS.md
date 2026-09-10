# `supabase whoami`

## Files Read

| Path                                                    | Format                    | When                                                                                       |
| ------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `<SUPABASE_HOME or ~/.supabase>/profile`                | plain text (profile name) | when `--profile` and `SUPABASE_PROFILE` are both unset                                     |
| profile path selected by `--profile`/`SUPABASE_PROFILE` | YAML                      | when the selected profile is a filesystem path                                             |
| keyring `"Supabase CLI"` / `<profile>`                  | OS keychain               | when `SUPABASE_ACCESS_TOKEN` is unset and keyring is available                             |
| keyring `"Supabase CLI"` / `access-token`               | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                   |
| `<SUPABASE_HOME or ~/.supabase>/access-token`           | plain text (token string) | last-resort fallback after environment and keyring lookup                                  |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json`         | JSON                      | when present, before post-run telemetry state is refreshed                                 |
| `<ancestor>/supabase/config.toml`                       | existence probe           | while resolving the default workdir; skipped when `--workdir` or `SUPABASE_WORKDIR` is set |

## Files Written

| Path                                            | Format | When                                                                                                                 |
| ----------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | during a first persistent identity stitch when applicable, then after command completion on both success and failure |

`whoami` is a user-level command. It does not resolve a project ref or write the linked-project
cache.

## API Routes

| Method | Path          | Auth         | Request body | Response (used fields)                                         |
| ------ | ------------- | ------------ | ------------ | -------------------------------------------------------------- |
| `GET`  | `/v1/profile` | Bearer token | none         | `{gotrue_id: string, primary_email: string, username: string}` |

## Environment Variables

| Variable                | Purpose                                                           | Required?                                                                     |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)              | no (falls back to keyring then `<SUPABASE_HOME or ~/.supabase>/access-token`) |
| `SUPABASE_HOME`         | overrides the CLI state directory                                 | no (defaults to `~/.supabase`)                                                |
| `SUPABASE_NO_KEYRING`   | disables the OS keyring, forcing the access-token file fallback   | no                                                                            |
| `SUPABASE_PROFILE`      | selects a built-in profile or a filesystem path to a YAML profile | no (falls back to the persisted profile, then `supabase`)                     |
| `SUPABASE_PROJECT_ID`   | loaded by shared command settings; unused by `whoami`             | no                                                                            |
| `SUPABASE_WORKDIR`      | sets the shared command workdir and skips ancestor config probing | no (falls back to searching upward from the current directory)                |

## Exit Codes

| Code | Condition                                                              |
| ---- | ---------------------------------------------------------------------- |
| `0`  | profile retrieved and printed                                          |
| `1`  | access token is missing or malformed                                   |
| `1`  | Management API request fails or returns a non-success/invalid response |
| `1`  | legacy `-o`/`--output` is supplied instead of `--output-format`        |

## Telemetry Events Fired

| Event                  | When                                                                                                              | Notable properties / groups                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `cli_command_executed` | post-run, success or failure (via wrapper)                                                                        | `exit_code`, `duration_ms`, `flags`        |
| `$create_alias`        | first authenticated response when telemetry consent is granted, no identity exists, and the runtime is persistent | aliases the device identity to `gotrue_id` |

## Output

### `--output-format text`

Prints a single-row table with `USER ID`, `USERNAME`, and `EMAIL` columns.

### `--output-format json`

Prints one JSON object with the profile fields:

```json
{
  "gotrue_id": "00000000-0000-0000-0000-000000000000",
  "primary_email": "user@example.com",
  "username": "example",
  "message": ""
}
```

### `--output-format stream-json`

Prints one `result` NDJSON event whose `data` contains `gotrue_id`, `primary_email`, `username`,
and `message: ""`.

### `-o` / `--output`

Every legacy output value is rejected with exit code 1:

```text
the -o/--output flag is not supported by whoami; use --output-format json|stream-json instead.
```

## Notes

- The command is read-only and uses the active profile's Management API base URL and access token.
- A successful Management API response participates in the shared telemetry identity stitch.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer authentication.
