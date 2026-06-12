# `supabase gen signing-key`

## Files Read

| Path                                            | Format                      | When                                                                                 |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `supabase/config.toml` / `supabase/config.json` | TOML / JSON                 | always when present in the active workdir; used to discover `auth.signing_keys_path` |
| `<resolved signing_keys_path>`                  | JSON array of JWKs          | when `auth.signing_keys_path` is configured; loaded before overwrite or append       |
| git ignore rules                                | git metadata / ignore files | best-effort after a successful write when the resulting file contains exactly 1 key  |

## Files Written

| Path                           | Format                    | When                                                               |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------ |
| `<resolved signing_keys_path>` | pretty JSON array of JWKs | when `auth.signing_keys_path` is configured and the write succeeds |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| -      | -    | -    | -            | -                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| -        | -       | -         |

## Exit Codes

| Code | Condition                                                                 |
| ---- | ------------------------------------------------------------------------- |
| `0`  | success                                                                   |
| `1`  | config parse failure                                                      |
| `1`  | configured signing key file missing or unreadable                         |
| `1`  | configured signing key file contains invalid JSON or an invalid JWK array |
| `1`  | overwrite declined (`context canceled`)                                   |
| `1`  | write failure                                                             |

## Output

### `--output-format text` (Go CLI compatible)

- When `auth.signing_keys_path` is unset, prints one compact JWK JSON object to stdout, then prints the local setup suggestion block to stderr, pointing at the active config file when one exists.
- When `auth.signing_keys_path` is set, prompts before overwrite unless `--append` is set, writes the file, then prints `JWT signing key appended to: ... (now contains N keys)` to stderr.
- When the resulting file contains exactly 1 key and is not gitignored, also prints the `IMPORTANT: Add your signing key path to .gitignore...` warning to stderr.

### `--output-format json`

Not applicable; the command uses raw stdout and stderr text like the Go CLI.

### `--output-format stream-json`

Not applicable; the command uses raw stdout and stderr text like the Go CLI.

## Notes

- `--algorithm` accepts `ES256` (default, recommended) or `RS256`.
- `--append` appends the new key to an existing keys file instead of overwriting.
- `auth.signing_keys_path` is resolved relative to the active `supabase/config.toml` or `supabase/config.json`.
- Generated keys are JWKs, not PEM files.
- No network or Management API calls are involved.
