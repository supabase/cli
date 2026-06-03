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

| Path                      | Format | When                                                                                                            |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `supabase/config.toml`    | TOML   | always on success; created from default template                                                                |
| `supabase/.gitignore`     | text   | when inside a git repo and the template is not already present                                                  |
| `.vscode/settings.json`   | JSON   | when interactive VS Code setup is accepted, or when `--with-vscode-settings` / `--with-vscode-workspace` is set |
| `.vscode/extensions.json` | JSON   | when interactive VS Code setup is accepted, or when `--with-vscode-settings` / `--with-vscode-workspace` is set |
| `.idea/deno.xml`          | XML    | when interactive IntelliJ setup is accepted, or when `--with-intellij-settings` is set                          |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| -      | -    | -    | -            | -                      |

## Environment Variables

None.

## Exit Codes

| Code | Condition                                                                            |
| ---- | ------------------------------------------------------------------------------------ |
| `0`  | success - prints "Finished supabase init."                                           |
| `1`  | `supabase/config.toml` already exists and `--force` was not provided                 |
| `1`  | permission denied writing config file                                                |
| `1`  | an existing `.vscode/settings.json` / `.vscode/extensions.json` is not valid JSON(C) |

## Output

### Legacy Output

On success:

```
Finished supabase init.
```

In interactive mode (`-i`/`--interactive`), may prompt for IDE settings preferences.

Success is emitted as raw text even when the legacy shell is invoked with non-text output modes.

## Notes

- Uses the invocation cwd directly and does not recurse upward looking for an existing project.
- The `--force` flag overwrites an existing `supabase/config.toml`.
- The `--use-orioledb` flag sets `UseOrioleDB` in init params; requires `--experimental` flag.
- The `--interactive` / `-i` flag enables IDE settings prompts (only effective in TTY).
- The `--with-vscode-settings` and `--with-vscode-workspace` flags are hidden backward-compat aliases for the same VS Code helper and both write `.vscode/settings.json` and `.vscode/extensions.json`.
- The `--with-intellij-settings` flag is a hidden backward-compat alias for generating `.idea/deno.xml`.
- An existing `.vscode/settings.json` / `.vscode/extensions.json` is parsed tolerantly through a JSONC boundary that strips line/block comments and trailing commas (matching Go's `jsonc.ToJSONInPlace`), then the template is merged on top (template keys win). An empty file is treated as absent and the template is written verbatim. A non-empty file that is not valid JSON(C) aborts the command with `InitParseSettingsError` and is left untouched rather than being overwritten.
- No authentication required - purely local file creation.
