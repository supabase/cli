# `supabase init`

## Files Read

| Path                      | Format     | When                                                                                             |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `supabase/config.json`    | JSON       | existence check, first, to fail fast unless `--force` is set                                     |
| `supabase/config.jsonc`   | JSONC      | existence check, second, to fail fast unless `--force` is set                                    |
| `supabase/config.toml`    | TOML       | existence check, last, to fail fast unless `--force` is set                                      |
| `.git/`                   | directory  | checked upward from the invocation cwd to decide whether `supabase/.gitignore` should be managed |
| `supabase/.gitignore`     | text       | only when inside a git repo and the file already exists                                          |
| `.vscode/settings.json`   | JSONC/JSON | when VS Code settings are generated and the file already exists                                  |
| `.vscode/extensions.json` | JSONC/JSON | when VS Code settings are generated and the file already exists                                  |

## Files Written

| Path                      | Format | When                                                                                                                    |
| ------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `supabase/config.json`    | -      | removed (if present) when `--force` is set, so the fresh `config.toml` is the file that loads                           |
| `supabase/config.jsonc`   | -      | removed (if present) when `--force` is set, so the fresh `config.toml` is the file that loads                           |
| `supabase/config.toml`    | TOML   | always on success; created from the default template, or the stack-opt-in template when `SUPABASE_EXPERIMENTAL_STACK=1` |
| `supabase/.gitignore`     | text   | when inside a git repo and the template is not already present                                                          |
| `.vscode/settings.json`   | JSON   | when interactive VS Code setup is accepted, or when `--with-vscode-settings` / `--with-vscode-workspace` is set         |
| `.vscode/extensions.json` | JSON   | when interactive VS Code setup is accepted, or when `--with-vscode-settings` / `--with-vscode-workspace` is set         |
| `.idea/deno.xml`          | XML    | when interactive IntelliJ setup is accepted, or when `--with-intellij-settings` is set                                  |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| -      | -    | -    | -            | -                      |

## Environment Variables

| Variable                                 | Purpose                                                                                                                                                                            | Required? |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_YES`                           | auto-accepts `-i` IDE prompts with the established stderr echo, same as `--yes`                                                                                                    | no        |
| `SUPABASE_EXPERIMENTAL_STACK`            | when true (`1`, `t`, `T`, `TRUE`, `true`, `True`), persist `[experimental] stack = true` and omit Docker-era default ports; false, unset, or empty writes the established template | no        |
| `SUPABASE_EXPERIMENTAL_MIGRATION_CHECKS` | when true (`1`, `t`, `T`, `TRUE`, `true`, `True`), write `[db.migrations.checks]` with every rule at `warn`; any other value or unset omits the section                            | no        |

## Exit Codes

| Code | Condition                                                                                     |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | success - prints "Finished supabase init."                                                    |
| `1`  | `supabase/config.json`, `config.jsonc` or `config.toml` exists and `--force` was not provided |
| `1`  | `SUPABASE_EXPERIMENTAL_STACK` is a non-empty value that is not a boolean                      |
| `1`  | permission denied writing config file                                                         |
| `1`  | an existing `.vscode/settings.json` / `.vscode/extensions.json` is not valid JSON(C)          |

## Output

### Text output

On success:

```
Finished supabase init.
```

In interactive mode (`-i`/`--interactive`), may prompt for IDE settings preferences.

Success is emitted as raw text even when the CLI is invoked with non-text output modes.

When `supabase/config.json`, `supabase/config.jsonc` or `supabase/config.toml` already exists and `--force` is not set (stderr; the first of those files in that order is named, and the platform check selects the exact per-OS path separator and errno text; `config.toml` is shown):

On Linux/macOS:

```
failed to create config file: open supabase/config.toml: file exists
Run supabase init --force to overwrite existing config file.
```

On Windows:

```
failed to create config file: open supabase\config.toml: The file exists.
Run supabase init --force to overwrite existing config file.
```

When `SUPABASE_EXPERIMENTAL_STACK` is a non-empty value that is not a boolean such as `1`, `0`, `true` or `false` (stderr; the second line is the generic debug hint appended on error):

```
Invalid SUPABASE_EXPERIMENTAL_STACK="yes" (sets experimental.stack): expected true or false.
Try rerunning the command with --debug to troubleshoot the error.
```

## Notes

- Uses the invocation cwd directly and does not recurse upward looking for an existing project.
- The `--force` flag overwrites an existing `supabase/config.toml` and removes any `supabase/config.json` / `supabase/config.jsonc`, since the project loader reads those before `config.toml`.
- `supabase/config.toml` starts with a `#:schema https://supabase.com/schemas/config/v1.json` directive so Taplo and Tombi validate it against the hosted schema.
- The `--use-orioledb` flag writes the OrioleDB version to `db.orioledb_version`; it does not require `--experimental`.
- `SUPABASE_EXPERIMENTAL_STACK=1` opts the new project into the experimental stack backend: the
  written config includes `[experimental] stack = true` and omits the Docker-era default ports
  (API, database, shadow, pooler, Studio, mail UI, Functions inspector, and Analytics).
  A non-empty value other than `0` or `1` fails closed. `0`, unset, or empty keeps the
  established template.
- The `--interactive` / `-i` flag enables IDE settings prompts (only effective in TTY).
- The `--with-vscode-settings` and `--with-vscode-workspace` flags are hidden backward-compat aliases for the same VS Code helper and both write `.vscode/settings.json` and `.vscode/extensions.json`.
- `.vscode/settings.json` includes `json.schemaDownload.trustedDomains` trusting `https://supabase.com/schemas/`, so VS Code loads the hosted config schema without an untrusted-location warning.
- The `--with-intellij-settings` flag is a hidden backward-compat alias for generating `.idea/deno.xml`.
- An existing `.vscode/settings.json` / `.vscode/extensions.json` is parsed tolerantly through a JSONC boundary that strips line/block comments and trailing commas, then the template is merged on top: nested objects are merged key by key with template values winning on conflicts, and arrays and scalars from the template replace the existing value. An empty file is treated as absent and the template is written verbatim. A non-empty file that is not valid JSON(C) aborts the command with `InitParseSettingsError` and is left untouched rather than being overwritten.
- No authentication required - purely local file creation.
