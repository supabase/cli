# `supabase config convert`

## Files Read

| Path                                | Format     | When                                                                                                                       |
| ----------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json[c]` | JSON/JSONC | always; parsed with the removed-key checks to detect a project already on JSON (no `.env*` file and no `[remotes.*]` read) |
| `<workdir>/supabase/config.toml`    | TOML       | always; re-read after the write to detect a concurrent edit                                                                |
| `<workdir>/.vscode/settings.json`   | JSONC      | after the write, only when it already exists                                                                               |
| `~/.supabase/telemetry.json`        | JSON       | always (telemetry state)                                                                                                   |

## Files Written

| Path                              | Format | When                                                                                                                                        |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.jsonc` | JSONC  | unless `--dry-run`; temp file then hard link (exclusive create without hard links), never replacing an existing file; mode of `config.toml` |
| `<workdir>/supabase/config.toml`  | —      | deleted after `config.jsonc` is written; kept when conversion is refused or either file changed on disk                                     |
| `<workdir>/.vscode/settings.json` | JSONC  | unless `--dry-run`; only when it exists and lacks the schema trusted domain; comments are preserved, or it is left unchanged with a warning |
| `~/.supabase/telemetry.json`      | JSON   | always (telemetry state)                                                                                                                    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                         | Purpose                            | Required? |
| -------------------------------- | ---------------------------------- | --------- |
| `SUPABASE_WORKDIR` / `--workdir` | project root used exactly as given | no        |
| `SUPABASE_HOME`                  | location of `telemetry.json`       | no        |

## Exit Codes

| Code | Condition                                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | converted (or `--dry-run` printed the document); warnings never change the exit code                                                                                                                                 |
| `0`  | only `config.json[c]` exists: nothing to convert, nothing written                                                                                                                                                    |
| `1`  | `-o/--output` passed                                                                                                                                                                                                 |
| `1`  | `--workdir` is not a directory                                                                                                                                                                                       |
| `1`  | no project config found, or it cannot be parsed (including malformed JSON or removed keys in `config.json[c]`)                                                                                                       |
| `1`  | `config.json` and `config.jsonc` both exist                                                                                                                                                                          |
| `1`  | `config.toml` exists next to `config.json[c]`, which takes precedence                                                                                                                                                |
| `1`  | conversion refused (invalid TOML, a TOML date, a non-finite float, failed re-parse check)                                                                                                                            |
| `1`  | `config.toml` changed, or `config.jsonc` or `config.json` appeared, while the command ran; an existing `config.jsonc` is never replaced, and the new one is removed only while it still holds what the command wrote |
| `1`  | `config.toml` could not be re-read after the write; the new `config.jsonc` is removed                                                                                                                                |
| `1`  | `config.jsonc` was removed, changed, or could not be re-read before `config.toml` was deleted; `config.toml` is kept                                                                                                 |
| `1`  | `config.jsonc` could not be written, or `config.toml` could not be removed afterwards                                                                                                                                |

## Output

### `--output-format text`

stdout is one report, printed after the files are written (colour only on a TTY, per `NO_COLOR`/`CLICOLOR`):

```text
✓ Converted supabase/config.toml to supabase/config.jsonc

  Changes
    + Created  supabase/config.jsonc
    - Deleted  supabase/config.toml
    ~ Updated  .vscode/settings.json (trusts https://supabase.com/schemas/)

  ℹ 1 comment relocated
    Comments inside multi-line values move to the line above their key.
    line 13 → api.extra  # first

  ⚠ Could not update .vscode/settings.json
    <detail>.
    Add "https://supabase.com/schemas/": true under "json.schemaDownload.trustedDomains" to trust the config schema.

  ⚠ Compatibility
    Supabase CLI versions before 3.1.0 ignore config.jsonc and run with defaults.
    Upgrade the Supabase CLI on every machine and CI job that uses this project.

  To undo:
    git restore supabase/config.toml && rm supabase/config.jsonc
```

The `~ Updated` line appears only when the settings changed, the `ℹ` section only for comments in nested arrays or inline tables (`N comments relocated` when more than one), and the VS Code warning only when the settings file cannot be parsed, written, or edited without dropping its comments. A failed write prints no report.

With only `config.json[c]` present, stdout is `supabase/config.jsonc is already the project config; nothing to convert.` (naming the actual file).

With `--dry-run`, stdout is the converted JSONC only; stderr gets a blank line and the same report headed `✓ Config conversion preview` / `  Dry run. No files were changed.`, with `Planned changes`, `Create`/`Delete`/`Update`, and `To undo after converting:`.

### `--output-format json`

`output.success("Converted supabase/config.toml to supabase/config.jsonc.", payload)` with
`path`, `converted: true`, `removed`, `schema`, `moved_comments[{line,key,text}]`,
`vscode_settings_updated`, `min_cli_version`, `warnings[]`. With `--dry-run` the message is the
dry-run line, `converted: false`, `dry_run: true` and `content` carry the document, `would_remove` and
`would_update_vscode_settings` replace `removed` and `vscode_settings_updated`, the compatibility
warning says `To undo after converting, run:`, and nothing is written. With only `config.json[c]` present the payload is `{ converted: false, path }`. Warnings
appear only in `warnings`.

### `--output-format stream-json`

Same structured result as `json`, delivered as an NDJSON `result` event.

## Notes

- The only flag is `--dry-run`; there is no confirmation prompt and no `--force`.
- The conversion parses `config.toml` only (no env resolution, no schema decode), so the JSONC
  document carries the same raw values. The result is re-parsed and compared before anything is
  written.
- `$schema` comes from a leading `#:schema` directive, an existing `"$schema"` key, or the current
  hosted schema URL.
- Commented-out TOML examples (`# key = value`, `# [table]` plus its keys) become commented-out JSONC members, so removing the `//` prefixes of one member yields valid JSONC; other comments are copied as prose.
- Comments inside multi-line arrays of plain values stay beside their elements; comments inside nested arrays or inline tables move to the line above their key and are reported.
- Skips the VS Code trusted-domain edit when the domain is already listed, whatever its value.
- `.vscode/settings.json` is never created.
- `-o/--output` is rejected in favour of `--output-format`.
