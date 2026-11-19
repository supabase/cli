---
id: config-validate
kind: command
category: config
title: config validate
symbol: supabase config validate
summary: Validate the project config file
usage: supabase config validate [flags]
description: |-
  Checks the project config file (`supabase/config.toml`, `config.json` or `config.jsonc`) and reports every problem in one pass, each with its key path and `file:line:column`. It never modifies a project file and never contacts the Supabase API.

  ## What is checked

  1. The file parses (TOML or JSONC).
  2. The schema version is one this CLI reads.
  3. Only one config file applies: `config.json` and `config.jsonc` together is an error, and `config.toml` next to a JSON file is reported as shadowed (the JSON file is the one used).
  4. With `--resolve-env` only, the `.env*` files load.
  5. Removed keys, unknown keys (with a `did you mean` suggestion when one is close), values of the wrong type, enum or range, and missing required keys.
  6. The config rules `supabase start` applies before it touches Docker, such as a missing provider secret or an unreadable `content_path` file. This does not cover Docker, ports or image pulls.
  7. Every `[remotes.<name>]` block, merged over the base config. Its problems carry the remote name, and a problem the base already has is reported once.

  Stages 1 to 3 and, with `--resolve-env`, stage 4 stop the run when they fail, because later checks cannot be computed; the report says where it stopped (`complete: false`, `stopped_at` in JSON). Everything from stage 5 on is reported together. `complete` is also `false` when a whole table had to be treated as unknown.

  ## Secrets

  The report shows key paths and `file:line:column`, never source text or values, in text and JSON alike (see [ADR 0034](https://github.com/supabase/cli/blob/develop/docs/adr/0034-config-diagnostics-print-no-source-text.md)). Environment variables are read only with `--resolve-env`, and `SUPABASE_*` key overrides are never read: the command validates the file as committed.

  ## `env()` references

  By default the command never reads the shell or any `.env*` file. A value written as `env(NAME)` is unknown: it is never an error by itself, and a check that reads it is not run. The report says how many values come from `env()` and how many checks were not run, and JSON lists them in `deferred` (`check`, `remote`, `waits_on`) with the count in `unknown_values`.

  With `--resolve-env` the command reads the shell and the `.env*` files (`supabase/` then the project root, selected by `SUPABASE_ENV`) and checks each value like a literal. A set value is validated and never printed. A variable that is unset (`env_unset`) or empty (`env_empty`, including a shell variable set to `""`, which hides a `.env` value) is reported with every place it is used, for example `NAME is not set. It is used at 12:3, 40:7`. It is an error when a check could not run without it or when it feeds a key that only accepts a number, boolean or one of a fixed set of values, and a warning otherwise. Warnings never change the exit code. An unreadable or unparseable `.env*` file stops the run at `env_file`.

  ## Two config files

  `config.json` and `config.jsonc` together is an error. `config.toml` next to a JSON file reports `shadowed_file`.

  ## Example

  ```text
    ✗ db.major_version  unsupported Postgres version
      supabase/config.toml:9:17
      help: use one of 14, 15, 17

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
    "unknown_values": 0,
    "deferred": [],
    "errors": [
      {
        "code": "invalid_value",
        "severity": "error",
        "key": "db.major_version",
        "path": "db.major_version",
        "reason": "unsupported Postgres version",
        "help": "use one of 14, 15, 17",
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

  Problem codes: `syntax`, `file_conflict`, `schema_version`, `removed_key`, `unknown_key`, `invalid_type`, `invalid_enum`, `invalid_value`, `missing_required`, `remote_project_id`, `env_file`, `env_unset`, `env_empty`, `deprecated_key`, `shadowed_file`, `unrecognized_schema`. Failures before a report exists (no config file, bad `--workdir`) use the generic `{"_tag":"Error",...}` envelope.

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
parameters:
  - name: --resolve-env
    location: flag
    type: boolean
    description: Read the shell and .env files, and check the values env() references supply. Without it, env() values are left unchecked.
    default: "false"
  - name: --agent
    location: flag
    type: "[ auto | yes | no ]"
    description: "Override agent detection: yes, no, or auto"
    default: auto
    allowed_values:
      - auto
      - "yes"
      - "no"
  - name: --debug
    location: flag
    type: boolean
    description: output debug logs to stderr
    default: "false"
  - name: --dns-resolver
    location: flag
    type: "[ native | https ]"
    description: lookup domain names using the specified resolver
    default: native
    allowed_values:
      - native
      - https
  - name: --experimental
    location: flag
    type: boolean
    description: enable experimental features
    default: "false"
  - name: --help
    location: flag
    type: boolean
    description: Show help information
    short: -h
    default: "false"
  - name: --network-id
    location: flag
    type: string
    description: use the specified docker network instead of a generated one
    default: ""
  - name: --output
    location: flag
    type: "[ env | pretty | json | toml | yaml ]"
    description: output format of status variables
    short: -o
    default: pretty
    allowed_values:
      - env
      - pretty
      - json
      - toml
      - yaml
  - name: --output-format
    location: flag
    type: "[ text | json | stream-json ]"
    description: "Output format: text, json, or stream-json (NDJSON)"
    default: text
    allowed_values:
      - text
      - json
      - stream-json
  - name: --profile
    location: flag
    type: string
    description: use a specific profile for connecting to Supabase API
    default: supabase
  - name: --workdir
    location: flag
    type: string
    description: path to the directory containing your supabase/ folder; used exactly as given, with no ancestor directory search (defaults to searching upward from the current directory)
    default: ""
  - name: --yes
    location: flag
    type: boolean
    description: answer yes to all prompts; hosted changes only accept this flag or SUPABASE_YES exported in your shell, never supabase/.env or another .env file
    default: "false"
inherits_flags: global-flags
examples:
  - id: example-1
    title: Validate supabase/config.toml, config.json or config.jsonc
    lang: sh
    code: supabase config validate
  - id: example-2
    title: Validate the config of another project directory
    lang: sh
    code: supabase config validate --workdir path/to/project
  - id: example-3
    title: Print the report as JSON for scripts and agents
    lang: sh
    code: supabase config validate --output-format json
  - id: example-4
    title: Also check the values that env() references take from the shell and .env files
    lang: sh
    code: supabase config validate --resolve-env
---
