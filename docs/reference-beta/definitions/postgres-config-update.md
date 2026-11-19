---
id: postgres-config-update
kind: command
category: postgres-config
title: postgres-config update
symbol: supabase postgres-config update
summary: Update Postgres database config
usage: supabase postgres-config update [flags]
description: |-
  Overriding the default Postgres config could result in unstable database behavior.
  Custom configuration also overrides the optimizations generated based on the compute add-ons in use.
  The update asks for confirmation (default No) before changing the overrides. Pass `--yes` to confirm without asking; JSON, stream-json, `-o` and non-interactive runs fail without it.
parameters:
  - name: --config
    location: flag
    type: strings
    description: Config overrides specified as a 'key=value' pair
    default: "[]"
  - name: --no-restart
    location: flag
    type: boolean
    description: Do not restart the database after updating config.
    default: "false"
  - name: --remote
    location: flag
    type: ref|branch
    description: "Target another project: `--remote=<ref|branch>`. Defaults to the linked project."
    default: "false"
  - name: --replace-existing-overrides
    location: flag
    type: boolean
    description: Replace all existing overrides with the ones provided. Omit this flag to merge overrides instead.
    default: "false"
  - name: --experimental
    location: flag
    type: boolean
    description: enable experimental features
    default: "false"
    required: true
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
examples: []
---
