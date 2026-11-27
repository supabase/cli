---
id: stop
kind: command
category: stop
title: stop
symbol: supabase stop
summary: Stop all local Supabase containers
usage: supabase stop [flags]
description: |-
  Stops the Supabase local development stack.

  Requires `supabase/config.toml` to be created in your current working directory by running `supabase init`.

  All Docker resources are maintained across restarts. Use `--no-backup` flag to reset your local development data between restarts.

  Use the `--all` flag to stop all local Supabase projects instances on the machine. Use with caution with `--no-backup` as it will delete all supabase local projects data.
parameters:
  - name: --all
    location: flag
    type: boolean
    description: Stop all local Supabase instances from all projects across the machine.
    default: "false"
  - name: --no-backup
    location: flag
    type: boolean
    description: Deletes all data volumes after stopping.
    default: "false"
  - name: --project-id
    location: flag
    type: string
    description: Local project ID to stop.
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
    title: Stop all local Supabase projects on this machine
    lang: sh
    code: supabase stop --all
---
