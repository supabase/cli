# `supabase init`

## Files Read

| Path                      | Format     | When                                                                                             |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `supabase/config.toml`    | TOML       | checked first to fail fast unless `--force` is set                                               |
| `.git/`                   | directory  | checked upward from the invocation cwd to decide whether `supabase/.gitignore` should be managed |
| `supabase/.gitignore`     | text       | only when inside a git repo and the file already exists                                          |
| `.vscode/settings.json`   | JSONC/JSON | when VS Code settings are generated and the file already exists                                  |
| `.vscode/extensions.json` | JSONC/JSON | when VS Code settings are generated and the file already exists                                  |

## Files Written

| Path                      | Format | When                                                                                                                    |
| ------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
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

| Variable                      | Purpose                                                                                                                                 | Required? |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_YES`                | auto-accepts `-i` IDE prompts with the established stderr echo, same as `--yes`                                                         | no        |
| `SUPABASE_EXPERIMENTAL_STACK` | when `1`, persist `[experimental] stack = true` and omit Docker-era default ports; `0`, unset, or empty writes the established template | no        |

## Exit Codes

| Code | Condition                                                                            |
| ---- | ------------------------------------------------------------------------------------ |
| `0`  | success - prints "Finished supabase init."                                           |
| `1`  | `supabase/config.toml` already exists and `--force` was not provided                 |
| `1`  | `SUPABASE_EXPERIMENTAL_STACK` is a non-empty value other than `0` or `1`             |
| `1`  | permission denied writing config file                                                |
| `1`  | an existing `.vscode/settings.json` / `.vscode/extensions.json` is not valid JSON(C) |

## Output

### Text output

On success:

```
Finished supabase init.
```

In interactive mode (`-i`/`--interactive`), may prompt for IDE settings preferences.

Success is emitted as raw text even when the CLI is invoked with non-text output modes.

When `supabase/config.toml` already exists and `--force` is not set (stderr; the platform check selects the exact per-OS path separator and errno text):

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

When `--use-orioledb` is passed without `--experimental` (stderr; the second line is the generic debug hint appended on error):

```
required flag(s) "experimental" not set
Try rerunning the command with --debug to troubleshoot the error.
```

When `SUPABASE_EXPERIMENTAL_STACK` is a non-empty value other than `0` or `1` (stderr; the second line is the generic debug hint appended on error):

```
SUPABASE_EXPERIMENTAL_STACK must be 0 or 1 when set
Try rerunning the command with --debug to troubleshoot the error.
```

## Notes

- Uses the invocation cwd directly and does not recurse upward looking for an existing project.
- The `--force` flag overwrites an existing `supabase/config.toml`.
- The `--use-orioledb` flag sets `UseOrioleDB` in init params; requires `--experimental` flag.
- `SUPABASE_EXPERIMENTAL_STACK=1` opts the new project into the experimental stack backend: the
  written config includes `[experimental] stack = true` and omits the Docker-era default ports
  (API, database, shadow, pooler, Studio, mail UI, Functions inspector, and Analytics).
  A non-empty value other than `0` or `1` fails closed. `0`, unset, or empty keeps the
  established template.
- The `--interactive` / `-i` flag enables IDE settings prompts (only effective in TTY).
- The `--with-vscode-settings` and `--with-vscode-workspace` flags are hidden backward-compat aliases for the same VS Code helper and both write `.vscode/settings.json` and `.vscode/extensions.json`.
- The `--with-intellij-settings` flag is a hidden backward-compat alias for generating `.idea/deno.xml`.
- An existing `.vscode/settings.json` / `.vscode/extensions.json` is parsed tolerantly through a JSONC boundary that strips line/block comments and trailing commas, then the template is merged on top (template keys win). An empty file is treated as absent and the template is written verbatim. A non-empty file that is not valid JSON(C) aborts the command with `InitParseSettingsError` and is left untouched rather than being overwritten.
- No authentication required - purely local file creation.
