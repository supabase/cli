---
id: init
kind: command
category: init
title: init
symbol: supabase init
summary: Initialize a local project
usage: supabase init [flags]
description: |-
  Initialize configurations for Supabase local development.

  A `supabase/config.toml` file is created in your current working directory. This configuration is specific to each local project.

  > You may override the directory path by specifying the `SUPABASE_WORKDIR` environment variable or `--workdir` flag.

  In addition to `config.toml`, the `supabase` directory may also contain other Supabase objects, such as `migrations`, `functions`, `tests`, etc.

  With `--use-orioledb`, the command writes the OrioleDB version to `db.orioledb_version` in `supabase/config.toml`; `--experimental` is not required.
parameters:
  - name: --force
    location: flag
    type: boolean
    description: Write a fresh supabase/config.toml, replacing an existing config.toml and removing any config.json or config.jsonc.
    default: "false"
  - name: --interactive
    location: flag
    type: boolean
    description: Enables interactive mode to configure IDE settings.
    short: -i
    default: "false"
  - name: --use-orioledb
    location: flag
    type: boolean
    description: Use OrioleDB storage engine for Postgres.
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
    title: Initialize a project using OrioleDB as the Postgres storage engine
    lang: sh
    code: supabase init --use-orioledb
---
