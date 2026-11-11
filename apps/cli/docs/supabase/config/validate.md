# supabase-config-validate

Checks the project config file (`supabase/config.toml`, `config.json` or `config.jsonc`) and reports every problem in one pass, each with its line and a code frame. It never modifies a project file and never contacts the Supabase API.

## What is checked

1. The file parses (TOML or JSONC).
2. The schema version is one this CLI reads.
3. Only one config file applies: `config.json` and `config.jsonc` together is an error, and `config.toml` next to a JSON file is reported as shadowed (the JSON file is the one used).
4. The env files load and no removed `SUPABASE_*` variable is set, so `env(NAME)` references and overrides resolve.
5. Removed keys, unknown keys (with a `did you mean` suggestion when one is close), values of the wrong type, enum or range, and missing required keys.
6. The validations `supabase start` applies, such as a missing provider secret or an unreadable `content_path` file.
7. Every `[remotes.<name>]` block, merged over the base config. Its problems carry the remote name.

Stages 1 to 4 stop the run when they fail, because later checks cannot be computed; the report says where it stopped (`complete: false`, `stopped_at` in JSON). A schema check that keeps finding dependent failures stops at `schema_limit` with the failures found so far. A remote `project_id` set by a `SUPABASE_REMOTES_*` variable is reported against that variable, not the file. Everything from stage 5 on is reported together.

## Secrets

Code frames show keys, headers and positions, never values: every value, on every line it spans, prints as `****`, and the text of comments is masked after its `#` or `//`. JSON output never contains source text or values. A value that comes from a `SUPABASE_*` variable is reported against its key, not a line.

## `env()` references

An unset `env(NAME)` is a warning when the section it sits in is enabled (the nearest `enabled` is not `false`), and the errors it would cause are not reported. Optional placeholders written by `supabase init` stay quiet. Warnings never change the exit code.

## Two config files

`config.json` and `config.jsonc` together is an error. `config.toml` next to a JSON file reports `shadowed_file`.

## Example

```text
  ✗ db.major_version  unsupported Postgres version
    supabase/config.toml:9:17
    8 │ [db]
  > 9 │ major_version = 16
      │                 ^^
    help: use one of 13, 14, 15, 17

✗ 1 error in supabase/config.toml
```

```json
{
  "schema_version": 1,
  "valid": false,
  "complete": true,
  "file": "supabase/config.toml",
  "format": "toml",
  "remotes": [],
  "errors": [
    {
      "code": "invalid_value",
      "severity": "error",
      "key": "db.major_version",
      "path": "db.major_version",
      "reason": "unsupported Postgres version",
      "help": "use one of 13, 14, 15, 17",
      "line": 9,
      "column": 17,
      "end_line": 9,
      "end_column": 19
    }
  ],
  "warnings": [],
  "message": "supabase/config.toml has 1 problem"
}
```

Problem codes: `syntax`, `file_conflict`, `schema_version`, `removed_key`, `unknown_key`, `invalid_type`, `invalid_enum`, `invalid_value`, `missing_required`, `remote_project_id`, `env_file`, `removed_env`, `env_unresolved`, `deprecated_key`, `shadowed_file`, `unrecognized_schema`. Remotes that could not be checked are listed in `skipped_remotes`. Failures before a report exists (no config file, bad `--workdir`) use the generic `{"_tag":"Error",...}` envelope.

The exit code is `0` when valid and `1` when there are errors. `-o/--output` is not supported; use `--output-format`.

## CI and pre-commit

```yaml
- run: supabase config validate
```

```yaml
repos:
  - repo: local
    hooks:
      - id: supabase-config-validate
        name: supabase config validate
        entry: supabase config validate
        language: system
        files: ^supabase/config\.(toml|jsonc?)$
        pass_filenames: false
```

```sh
supabase config validate
supabase config validate --workdir path/to/project
supabase config validate --output-format json
```
