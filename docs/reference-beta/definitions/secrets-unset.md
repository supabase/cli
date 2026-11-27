---
id: secrets-unset
kind: command
category: secrets
title: secrets unset
symbol: supabase secrets unset
summary: Unset a secret(s) on Supabase
usage: supabase secrets unset [NAME] ... [flags]
description: Unset a secret(s) from the linked Supabase project.
parameters:
  - name: NAME
    location: positional
    required: false
    variadic: true
  - name: --all
    location: flag
    type: boolean
    description: Unset every secret except SUPABASE_ ones. Required when no names are given.
    default: "false"
  - name: --dry-run
    location: flag
    type: boolean
    description: Print the secrets that would be unset without unsetting them.
    default: "false"
  - name: --remote
    location: flag
    type: ref|branch
    description: "Target another project: `--remote=<ref|branch>`. Defaults to the linked project."
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
    title: Unset a secret by name
    lang: sh
    code: supabase secrets unset MY_SECRET
  - id: example-2
    title: Unset multiple secrets
    lang: sh
    code: supabase secrets unset MY_SECRET OTHER_SECRET
  - id: example-3
    title: Unset every custom secret after confirming
    lang: sh
    code: supabase secrets unset --all
  - id: example-4
    title: Preview which secrets --all would unset
    lang: sh
    code: supabase secrets unset --all --dry-run
---
