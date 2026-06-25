# `supabase functions new <Function name>`

## Files Read

| Path                                            | Format     | When                                                                                                                                   |
| ----------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/profile`                           | plain text | when `--profile` and `SUPABASE_PROFILE` are both unset                                                                                 |
| `<profile>.yaml`                                | YAML       | when `SUPABASE_PROFILE` or `--profile` points to a file                                                                                |
| `<workdir>/supabase/config.toml`                | TOML       | best-effort when resolving template values, detecting existing `[functions.<name>]` declarations, and scanning declared function slugs |
| `<workdir>/supabase/functions/*/index.ts`       | TypeScript | when checking whether this is the first local function                                                                                 |
| `<workdir>/.vscode/extensions.json`             | JSONC      | when merging VS Code recommendations into an existing file                                                                             |
| `<workdir>/.vscode/settings.json`               | JSONC      | when merging Deno settings into an existing file                                                                                       |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON       | when present, before post-run telemetry state is refreshed                                                                             |

## Files Written

| Path                                            | Format     | When                                                                                                               |
| ----------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/functions/<name>/index.ts`  | TypeScript | always                                                                                                             |
| `<workdir>/supabase/functions/<name>/deno.json` | JSON       | always                                                                                                             |
| `<workdir>/supabase/functions/<name>/.npmrc`    | plain text | always                                                                                                             |
| `<workdir>/supabase/config.toml`                | TOML       | always unless `[functions.<name>]` is already declared                                                             |
| `<workdir>/.vscode/extensions.json`             | JSON       | text mode only, when this is the first function and VS Code settings are accepted or auto-accepted                 |
| `<workdir>/.vscode/settings.json`               | JSON       | text mode only, when this is the first function and VS Code settings are accepted or auto-accepted                 |
| `<workdir>/.idea/deno.xml`                      | XML        | text mode only, when this is the first function, VS Code settings are declined, and IntelliJ settings are accepted |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON       | after command completion, flushed on both success and failure paths                                                |

## API Routes

| Method | Path   | Auth   | Request body | Response (used fields) |
| ------ | ------ | ------ | ------------ | ---------------------- |
| `none` | `none` | `none` | `none`       | `none`                 |

## Environment Variables

| Variable                | Purpose                                                                                    | Required?                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | resolved into legacy CLI config even though this command performs no API calls             | no (falls back to credential lookup paths that are not used here) |
| `SUPABASE_HOME`         | changes where telemetry state is persisted                                                 | no (defaults to `~/.supabase`)                                    |
| `SUPABASE_PROFILE`      | selects a built-in profile or YAML profile path during legacy CLI config resolution        | no (falls back to `~/.supabase/profile` -> `supabase`)            |
| `SUPABASE_PROJECT_ID`   | resolved into legacy CLI config even though this command does not use a linked project ref | no                                                                |
| `SUPABASE_WORKDIR`      | sets `<workdir>` for all local project reads and writes                                    | no (falls back to `--workdir` -> current working dir)             |

## Exit Codes

| Code | Condition                          |
| ---- | ---------------------------------- |
| `0`  | success                            |
| `1`  | invalid function name              |
| `1`  | function entrypoint already exists |
| `1`  | local file write failed            |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text` (Go CLI compatible)

Prints `Created new Function at <path>` and, when this is the first function, may also print the IDE prompt plus generated settings messages.

### `--output-format json`

Emits a structured success payload with `path`, `function_name`, and `auth`. No IDE settings are scaffolded and no IDE prompt is printed — machine formats are payload-only.

### `--output-format stream-json`

Emits a structured success result event with `path`, `function_name`, and `auth`. No IDE settings are scaffolded and no IDE prompt is printed — machine formats are payload-only.

## Notes

- Creates a new Edge Function scaffold locally.
- Requires exactly one argument: the function name.
- `--auth` selects the auth-mode template (`none` | `apikey` | `user`, default: `apikey`).
- Best-effort config parsing is intentionally non-fatal here: malformed `config.toml` does not block scaffolding or config append, matching the Go command.
- The `[functions.<name>]` config section is **appended** (`O_APPEND` semantics, `flag: "a"`), never rewritten, so the existing file is left byte-for-byte untouched and a partial write cannot truncate it — matching Go's `appendConfigFile`.
- Existing-declaration detection scans the raw `config.toml` text (`^\s*\[functions\.<slug>\]\s*$`) rather than the parsed config map Go uses. This is a deliberate divergence: config loading here is non-fatal, so a raw-text scan stays deterministic even when the file fails to parse. For all well-formed configs the two approaches agree.
- IDE settings scaffolding (`.vscode`, `.idea`) only runs in `--output-format text`; json / stream-json runs are payload-only.
- No Management API requests are made; all behavior is local filesystem work plus telemetry flush.
