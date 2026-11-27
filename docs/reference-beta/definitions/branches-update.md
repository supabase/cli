---
id: branches-update
kind: command
category: branches
title: branches update
symbol: supabase branches update
summary: Update a preview branch
usage: supabase branches update [name] [flags]
description: Update a preview branch by its name or ID.
parameters:
  - name: name
    location: positional
    required: false
  - name: --git-branch
    location: flag
    type: string
    description: Change the associated git branch.
    default: ""
  - name: --name
    location: flag
    type: string
    description: Rename the preview branch.
    default: ""
  - name: --notify-url
    location: flag
    type: string
    description: URL to notify when branch is active healthy.
    default: ""
  - name: --persistent
    location: flag
    type: boolean
    description: Switch between ephemeral and persistent branch.
    default: "false"
  - name: --remote
    location: flag
    type: ref
    description: "Target another project: `--remote=<ref>`. Defaults to the linked project."
    default: "false"
  - name: --status
    location: flag
    type: string
    description: Override the current branch status.
    default: ""
    allowed_values:
      - RUNNING_MIGRATIONS
      - MIGRATIONS_PASSED
      - MIGRATIONS_FAILED
      - FUNCTIONS_DEPLOYED
      - FUNCTIONS_FAILED
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
examples: []
---
