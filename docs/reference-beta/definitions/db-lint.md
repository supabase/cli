---
id: db-lint
kind: command
category: db
title: db lint
symbol: supabase db lint
summary: Checks a database for typing error
usage: supabase db lint [flags]
description: |-
  Lints a database for schema errors.

  Lints the local database by default, which requires the local development stack to be running. Pass `--remote` to lint the linked project, or `--remote=<ref|branch|url>` to lint another project, a branch of the linked project, or a database URL such as a self-hosted database. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

  Runs the `plpgsql_check` extension against the local database (native or container) to check for errors in all schemas. The default lint level is `warning` and can be raised to error via the `--level` flag.

  The `--fail-on` flag can be used to control when the command should exit with a non-zero status code. The possible values are:

  - `none` (default): Always exit with a zero status code, regardless of lint results.
  - `warning`: Exit with a non-zero status code if any warnings or errors are found.
  - `error`: Exit with a non-zero status code only if errors are found.

  This flag is particularly useful in CI/CD pipelines where you want to fail the build based on certain lint conditions.
parameters:
  - name: --fail-on
    location: flag
    type: "[ none | warning | error ]"
    description: Error level to exit with non-zero status.
    default: none
    allowed_values:
      - none
      - warning
      - error
  - name: --level
    location: flag
    type: "[ warning | error ]"
    description: Error level to emit.
    default: warning
    allowed_values:
      - warning
      - error
  - name: --remote
    location: flag
    type: ref|branch|url
    description: "Target a remote database: the linked project, or `--remote=<ref|branch|url>`."
    default: "false"
  - name: --schema
    location: flag
    type: strings
    description: Comma separated list of schema to include.
    short: -s
    default: "[]"
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
    default: ""
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
    title: Lint only the public schema
    lang: sh
    code: supabase db lint --schema public
  - id: example-2
    title: Exit with a non-zero status if warnings or errors are found
    lang: sh
    code: supabase db lint --fail-on warning
  - id: example-3
    title: Exit with a non-zero status only if errors are found
    lang: sh
    code: supabase db lint --fail-on error
---
