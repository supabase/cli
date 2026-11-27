---
id: functions-deploy
kind: command
category: functions
title: functions deploy
symbol: supabase functions deploy
summary: Deploy a Function to Supabase
usage: supabase functions deploy [Function name] ... [flags]
description: Deploy a Function to the linked Supabase project.
parameters:
  - name: Function name
    location: positional
    required: false
    variadic: true
  - name: --import-map
    location: flag
    type: string
    description: Path to import map file.
    default: ""
  - name: --jobs
    location: flag
    type: int
    description: Maximum number of parallel jobs.
    short: -j
    default: "1"
  - name: --no-verify-jwt
    location: flag
    type: boolean
    description: Disable JWT verification for the Function.
    default: "false"
  - name: --prune
    location: flag
    type: boolean
    description: Delete Functions that exist in Supabase project but not locally.
    default: "false"
  - name: --remote
    location: flag
    type: ref|branch
    description: "Target another project: `--remote=<ref|branch>`. Defaults to the linked project."
    default: "false"
  - name: --use-api
    location: flag
    type: boolean
    description: Bundle functions server-side without using Docker.
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
    title: Deploy a single function to the linked project
    lang: sh
    code: supabase functions deploy hello-world
  - id: example-2
    title: Deploy all local functions to a specific project
    lang: sh
    code: supabase functions deploy --remote=abcdefghijklmnopqrst
---
