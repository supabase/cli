# `supabase init`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path                      | Format | When                                                     |
| ------------------------- | ------ | -------------------------------------------------------- |
| `supabase/config.toml`    | TOML   | always on success; created from default template         |
| `supabase/.gitignore`     | text   | always on success; gitignores runtime state              |
| `.vscode/settings.json`   | JSON   | when `--with-vscode-settings` flag is set (deprecated)   |
| `.vscode/extensions.json` | JSON   | when `--with-vscode-workspace` flag is set (deprecated)  |
| `.idea/deno.xml`          | XML    | when `--with-intellij-settings` flag is set (deprecated) |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable  | Purpose                                    | Required? |
| --------- | ------------------------------------------ | --------- |
| `WORKDIR` | overrides working directory (set to `"."`) | no        |

## Exit Codes

| Code | Condition                                                            |
| ---- | -------------------------------------------------------------------- |
| `0`  | success — prints "Finished supabase init."                           |
| `1`  | `supabase/config.toml` already exists and `--force` was not provided |
| `1`  | permission denied writing config file                                |

## Output

### `--output-format text` (Go CLI compatible)

On success:

```
Finished supabase init.
```

In interactive mode (`-i`/`--interactive`), may prompt for IDE settings preferences.

### `--output-format json`

Not applicable — init produces no machine-readable output.

### `--output-format stream-json`

Not applicable — init produces no structured output.

## Notes

- Sets `WORKDIR` to `"."` in `PersistentPreRunE` to prevent recursing to parent directories.
- The `--force` flag overwrites an existing `supabase/config.toml`.
- The `--use-orioledb` flag sets `UseOrioleDB` in init params; requires `--experimental` flag.
- The `--interactive` / `-i` flag enables IDE settings prompts (only effective in TTY).
- The `--with-vscode-settings`, `--with-vscode-workspace`, and `--with-intellij-settings` flags are hidden backward-compat aliases.
- No authentication required — purely local file creation.
