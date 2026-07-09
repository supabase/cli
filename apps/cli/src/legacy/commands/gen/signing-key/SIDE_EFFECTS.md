# `supabase gen signing-key`

## Files Read

| Path                                            | Format                      | When                                                                                  |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `supabase/config.toml` / `supabase/config.json` | TOML / JSON                 | always when present in the active workdir; used to discover `auth.signing_keys_path`  |
| `<resolved signing_keys_path>`                  | JSON array of JWKs          | when `auth.signing_keys_path` is configured; loaded before overwrite or append        |
| git ignore rules                                | git metadata / ignore files | best-effort after a successful write when the resulting file contains exactly 1 key   |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`   | dotenv                      | always, to resolve `SUPABASE_YES` (CLI-1878; Go's `flags.LoadConfig`/`loadNestedEnv`) |

## Files Written

| Path                           | Format                    | When                                                               |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------ |
| `<resolved signing_keys_path>` | pretty JSON array of JWKs | when `auth.signing_keys_path` is configured and the write succeeds |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| -      | -    | -    | -            | -                      |

## Environment Variables

| Variable       | Purpose                                                                                                                                                                                          | Required? |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `SUPABASE_YES` | Auto-confirms the overwrite prompt, same as `--yes` (Go's `viper.GetBool("YES")`). Read from the shell env OR the project `.env`/`.env.local`/`.env.<env>[.local]` files (shell wins; CLI-1878). | No        |

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

Not applicable to output rendering; the command uses raw stdout and stderr text like the Go CLI. It does, however, affect the overwrite-confirmation prompt: since this command has no structured json/stream-json payload, requesting a non-text format from a real interactive terminal (no `--yes`, no piped stdin) fails the overwrite closed (`context canceled`) rather than silently defaulting to yes on a destructive, irreversible action. A non-TTY caller (piped or not) is unaffected — piped `y`/`n` answers are honored regardless of `--output-format`.

### `--output-format stream-json`

Same as `--output-format json` above.

## Notes

- `--algorithm` accepts `ES256` (default, recommended) or `RS256`.
- `--append` appends the new key to an existing keys file instead of overwriting.
- The overwrite prompt honors `SUPABASE_YES` (shell env or the project `.env`/`.env.local`/`.env.<env>[.local]` files, shell wins) and an explicit `--yes=false` override, matching Go's `viper.GetBool("YES")` precedence (flag wins over env; an omitted flag falls back to the env var, resolved after `flags.LoadConfig` loads the project env — CLI-1878). On non-TTY stdin, a piped `y`/`n` line is read within a 100ms timeout and honored before falling back to the default (`y`), matching Go's `Console.ReadLine`/`PromptYesNo` — a piped answer other than an exact `y`/`yes`/`n`/`no` (case-insensitive) also falls back to the default.
- `auth.signing_keys_path` is resolved relative to the active `supabase/config.toml` or `supabase/config.json`.
- Generated keys are JWKs, not PEM files.
- No network or Management API calls are involved.
