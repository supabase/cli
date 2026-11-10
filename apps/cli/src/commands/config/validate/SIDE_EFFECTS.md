# `supabase config validate`

## Files Read

| Path                                                              | Format     | When                                                                                         |
| ----------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`, `config.json` or `config.jsonc` | TOML/JSONC | always; the same text is reused for the code frames                                          |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`                     | dotenv     | always, selected by `SUPABASE_ENV`, to resolve `env()` references and `SUPABASE_*` overrides |
| `<workdir>/supabase/<content_path>`                               | text       | when an `auth.email.template.*` or notification `content_path` is set                        |
| `<workdir>/supabase/<cert_path>`, `<key_path>`                    | PEM        | when `api.tls.enabled` is true                                                               |
| `<workdir>/supabase/<signing_keys_path>`                          | JSON       | when `auth.signing_keys_path` is set                                                         |
| `~/.supabase/telemetry.json`                                      | JSON       | always (telemetry state)                                                                     |

`<workdir>/supabase/.temp/project-ref` is never read: remotes are selected by name, not by the linked project.

## Files Written

| Path                         | Format | When                                                         |
| ---------------------------- | ------ | ------------------------------------------------------------ |
| `~/.supabase/telemetry.json` | JSON   | always (telemetry state)                                     |
| `~/.supabase/cli-latest`     | text   | the global update notice, when its cache is stale; see Notes |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                         | Purpose                                                              | Required? |
| -------------------------------- | -------------------------------------------------------------------- | --------- |
| `SUPABASE_WORKDIR` / `--workdir` | project root used exactly as given                                   | no        |
| `SUPABASE_ENV`                   | selects which `.env.<name>` files are read                           | no        |
| `SUPABASE_<KEY>`                 | overrides a config value; an invalid one is reported against its key | no        |
| `SUPABASE_HOME`                  | location of `telemetry.json`                                         | no        |

## Exit Codes

| Code | Condition                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the config is valid; warnings never change the exit code                                                                      |
| `1`  | the config has problems; the report is printed and the command itself succeeds (same pattern as `db lint`)                    |
| `1`  | `config.json` and `config.jsonc` both exist (`file_conflict`); `config.toml` next to a JSON file is a `shadowed_file` problem |
| `1`  | a `[remotes.*]` block has an invalid or duplicate `project_id`                                                                |
| `1`  | no project config found, `--workdir` is not a directory, or `-o/--output` was passed (generic error envelope in JSON mode)    |

Telemetry records a run that reports problems as a successful command, because the exit code is set after the handler succeeds.

## Run order and stops

Each stage reports every problem it finds; a run stops after a stage only when the later stages cannot be computed: `syntax`, `schema_version`, `file_conflict`, `env_file`, `removed_env`, `schema_limit` (dependent schema failures hit the check's round limit). Remote blocks, unknown keys, removed keys, type and value errors and the semantic checks `supabase start` applies are all reported in one pass. JSON output sets `complete: false` and `stopped_at` when a run stopped early.

## Output

### `--output-format text`

stdout is one report: every problem in file order, each as `<key>  <reason>` with `file:line:column`, a code frame, an optional `help:` line and a `[remote: <name>]` label, then a total. Colour only on a TTY, per `NO_COLOR`/`CLICOLOR`. Values are masked as `****`, on every line they span, unless the key is a known non-secret setting and its value is the only value on that line and is a plain number, boolean or string without escapes or multi-line delimiters; arrays, tables and everything else on the line stay masked, and URL credentials and query strings are redacted in any shown string; `env(NAME)` references stay visible. A document that cannot be parsed is masked line by line in full. Nothing is written to stderr by the command itself.

### `--output-format json`

`{"schema_version":1,"valid","complete","stopped_at"?,"file","format","remotes":[],"skipped_remotes"?,"errors":[],"warnings":[],"message"}`. Each entry has `code`, `severity`, `reason` and, when known, `key`, `path`, `remote`, `file`, `help`, `line`, `column`, `end_line`, `end_column`. Codes: `syntax`, `file_conflict`, `schema_version`, `removed_key`, `unknown_key`, `invalid_type`, `invalid_enum`, `invalid_value`, `missing_required`, `remote_project_id`, `env_file`, `removed_env`, `env_unresolved`, `deprecated_key`, `shadowed_file`, `unrecognized_schema`. It never contains source text or configured values. Failures before a report exists (no config, bad `--workdir`, `-o`) use the generic `{"_tag":"Error",...}` envelope.

### `--output-format stream-json`

Same structured result as `json`, delivered as an NDJSON `result` event.

## Notes

- No config or project file is created or changed and no Management API call is made. The CLI still writes `telemetry.json`, and the global update notice that follows every command can fetch the latest release tag and write `cli-latest` and print a notice on stderr; this command does not change that behaviour.
- Every `[remotes.<name>]` block is validated merged over the base config, whatever the linked project is.
- An unresolved `env(NAME)` is a warning when its nearest `enabled` gate is not `false` (or the key is an optional placeholder `supabase init` writes), and value errors (type, enum, value, missing) it causes at or below that key are not reported; unknown-key, removed-key and `SUPABASE_*`-sourced errors still are. A remote whose `project_id` is an unset `env()` reference is skipped with a warning, and a reference a `SUPABASE_*` variable overrides is not reported. A base reference a remote inherits is checked against that remote's own gates. A `remotes` key or `remotes.<name>` entry that is not a table is an `invalid_type` error. An error whose value a `SUPABASE_*` variable supplies names the variable and carries no file location.
- `-o/--output` is rejected in favour of `--output-format`.
