# `supabase config validate`

## Files Read

| Path                                                              | Format     | When                                                                                             |
| ----------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`, `config.json` or `config.jsonc` | TOML/JSONC | always; read to locate each problem's line and column                                            |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`                     | dotenv     | only with `--resolve-env`, selected by `SUPABASE_ENV`, to resolve `env()` references             |
| `<workdir>/<content_path>`                                        | text       | when `auth.enabled` and an `auth.email.template.*` or enabled notification `content_path` is set |
| `<workdir>/supabase/<cert_path>`, `<key_path>`                    | PEM        | when `api.enabled` and `api.tls.enabled` are true                                                |
| `<workdir>/supabase/<signing_keys_path>`                          | JSON       | when `auth.enabled` and `auth.signing_keys_path` is set                                          |
| `~/.supabase/telemetry.json`                                      | JSON       | always (telemetry state)                                                                         |

A notification `content_path` missing from the project root falls back to `<workdir>/supabase/<content_path>`. The `content_path`, TLS and signing-key files are never read when the path comes from `env()`, unless `--resolve-env` resolves it.

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

| Variable                         | Purpose                                                                                                  | Required? |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_WORKDIR` / `--workdir` | project root used exactly as given                                                                       | no        |
| `SUPABASE_ENV`                   | selects which `.env.<name>` files are read, with `--resolve-env`                                         | no        |
| `<NAME>` of an `env(NAME)`       | the value of a reference, read only with `--resolve-env`                                                 | no        |
| `DOTENV_PRIVATE_KEY*`            | decrypts `encrypted:` secrets, read only with `--resolve-env`; without it an encrypted secret is unknown | no        |
| `SUPABASE_HOME`                  | location of `telemetry.json`                                                                             | no        |

## Exit Codes

| Code | Condition                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the config is valid; warnings never change the exit code                                                                      |
| `1`  | the config has problems; the report is printed and the command itself succeeds (same pattern as `db lint`)                    |
| `1`  | `config.json` and `config.jsonc` both exist (`file_conflict`); `config.toml` next to a JSON file is a `shadowed_file` problem |
| `1`  | a `[remotes.*]` block has an invalid or duplicate `project_id`, or `--resolve-env` finds a variable a check needs unset       |
| `1`  | no project config found, `--workdir` is not a directory, or `-o/--output` was passed (generic error envelope in JSON mode)    |

Telemetry records a run that exits 1 as a failed command classified as a user-actionable `invalid_config` error (`ConfigValidateProblemsError`), because the exit code is set after the handler succeeds rather than by a raised error.

## Run order and stops

Each stage reports every problem it finds; a run stops after a stage only when the later stages cannot be computed: `syntax`, `schema_version`, `file_conflict`, and with `--resolve-env` `env_file`. Remote blocks, unknown keys, removed keys, type and value errors and the config rules `supabase start` applies before it touches Docker are all reported in one pass. JSON output sets `complete: false` and `stopped_at` when a run stopped early, and `complete: false` when a whole table was treated as unknown.

## Output

### `--output-format text`

stdout is one report: every problem in file order, each as `<key>  <reason>` with `file:line:column`, an optional `help:` line and a `[remote: <name>]` label, then a total. Colour only on a TTY, per `NO_COLOR`/`CLICOLOR`. The report shows key paths and `file:line:column`, never source text or values; see [ADR 0034](../../../../../../docs/adr/0034-config-diagnostics-print-no-source-text.md). Nothing is written to stderr by the command itself.

### `--output-format json`

`{"schema_version":1,"valid","complete","stopped_at"?,"file","format","remotes":[],"unknown_values","deferred":[{"check","remote"?,"reason","waits_on":[]}],"errors":[],"warnings":[],"message"}`. Each entry has `code`, `severity`, `reason` and, when known, `key`, `path`, `remote`, `file`, `help`, `line`, `column`, `end_line`, `end_column`. Codes: `syntax`, `file_conflict`, `schema_version`, `removed_key`, `unknown_key`, `invalid_type`, `invalid_enum`, `invalid_value`, `missing_required`, `remote_project_id`, `env_file`, `env_unset`, `env_empty`, `deprecated_key`, `shadowed_file`, `unrecognized_schema`. It never contains source text or configured values. Failures before a report exists (no config, bad `--workdir`, `-o`) use the generic `{"_tag":"Error",...}` envelope.

### `--output-format stream-json`

Same structured result as `json`, delivered as an NDJSON `result` event.

## Notes

- No config or project file is created or changed and no Management API call is made. The CLI still writes `telemetry.json`, and the global update notice that follows every command can fetch the latest release tag and write `cli-latest` and print a notice on stderr; this command does not change that behaviour.
- Every `[remotes.<name>]` block is validated merged over the base config, whatever the linked project is.
- An `env(NAME)` value is unknown by default: it never causes an error, and checks that read it are listed as deferred with `reason: "env"`. A check that reads a value that is itself invalid or missing is deferred with `reason: "invalid"`; the text report counts those separately and recommends `--resolve-env` only for the `env` ones. `--resolve-env` reads the shell and `.env*` files and reports unset or empty variables (`env_unset`, `env_empty`) as errors when a check needs them or they feed a number, port or boolean key, and as warnings otherwise. It checks the config rules `supabase start` applies before it touches Docker; it does not cover Docker, ports or image pulls.
- `SUPABASE_*` key overrides are never read; the command validates the file as committed. A remote `project_id` is checked as written. A `remotes` key or `remotes.<name>` entry that is not a table is an `invalid_type` error. A JSON config whose top level is not an object stops the run at the `syntax` stage.
- `-o/--output` is rejected in favour of `--output-format`.
