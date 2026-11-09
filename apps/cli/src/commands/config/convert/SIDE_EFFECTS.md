# `supabase config convert`

## Files Read

| Path                                | Format    | When                                                                                    |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json[c]` | existence | always, to detect a project already on JSON (no `.env*` file and no `[remotes.*]` read) |
| `<workdir>/supabase/config.toml`    | TOML      | always; re-read after the write to detect a concurrent edit                             |
| `<workdir>/.vscode/settings.json`   | JSONC     | after the write, only when it already exists                                            |
| `~/.supabase/telemetry.json`        | JSON      | always (telemetry state)                                                                |

## Files Written

| Path                              | Format | When                                                                                                    |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.jsonc` | JSONC  | unless `--dry-run`; temp file then hard link, never replacing an existing file; mode of `config.toml`   |
| `<workdir>/supabase/config.toml`  | —      | deleted after `config.jsonc` is written; kept when conversion is refused or either file changed on disk |
| `<workdir>/.vscode/settings.json` | JSONC  | unless `--dry-run`; only when it exists and lacks the schema trusted domain; comments are preserved     |
| `~/.supabase/telemetry.json`      | JSON   | always (telemetry state)                                                                                |

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

| Code | Condition                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------- |
| `0`  | converted (or `--dry-run` printed the document); warnings never change the exit code                                 |
| `0`  | only `config.json[c]` exists: nothing to convert, nothing written                                                    |
| `1`  | `-o/--output` passed                                                                                                 |
| `1`  | `--workdir` is not a directory                                                                                       |
| `1`  | no project config found, or it cannot be parsed                                                                      |
| `1`  | `config.toml` exists next to `config.json[c]`, which takes precedence                                                |
| `1`  | conversion refused (invalid TOML, a TOML date, a non-finite float, failed re-parse check)                            |
| `1`  | `config.toml` changed or `config.jsonc` appeared while the command ran; an existing `config.jsonc` is never replaced |
| `1`  | `config.toml` could not be re-read after the write; the new `config.jsonc` is removed                                |
| `1`  | `config.jsonc` could not be written, or `config.toml` could not be removed afterwards                                |

## Output

### `--output-format text`

stdout:

- `Converted supabase/config.toml to supabase/config.jsonc.`
- `Removed supabase/config.toml; supabase/config.jsonc is now the project config.`
- `Added https://supabase.com/schemas/ to json.schemaDownload.trustedDomains in .vscode/settings.json.` when the VS Code settings changed

stderr (warnings; the first two are printed before anything is written, in this order):

- `Moved N comment(s) that were inside multi-line values to the line above their key:` followed by one `  line N → <key>: # …` line per comment, only for comments in nested arrays or inline tables
- `Older Supabase CLIs (before 3.1.0) ignore config.jsonc and run with defaults; some commands (init, functions new) create a new config.toml that newer CLIs then ignore. Upgrade every machine and CI job that runs supabase for this project. To undo, run: git restore supabase/config.toml && rm supabase/config.jsonc`
- `Could not update .vscode/settings.json: <detail>. …` after the write, when the settings file cannot be parsed or written

With only `config.json[c]` present, stdout is `supabase/config.jsonc is already the project config; nothing to convert.` (naming the actual file).

With `--dry-run`, stdout is the converted JSONC only; stderr gets `Dry run: would write supabase/config.jsonc and delete supabase/config.toml.` (with `.vscode/settings.json` changing: `Dry run: would write supabase/config.jsonc, delete supabase/config.toml, and add the schema domain to .vscode/settings.json.`) and the warnings.

### `--output-format json`

`output.success("Converted supabase/config.toml to supabase/config.jsonc.", payload)` with
`path`, `converted: true`, `removed`, `schema`, `moved_comments[{line,key,text}]`,
`vscode_settings_updated`, `min_cli_version`, `warnings[]`. With `--dry-run` the message is the
dry-run line, `converted: false`, `dry_run: true` and `content` carry the document, `would_remove` and
`would_update_vscode_settings` replace `removed` and `vscode_settings_updated`, and nothing is
written. With only `config.json[c]` present the payload is `{ converted: false, path }`. Warnings
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
