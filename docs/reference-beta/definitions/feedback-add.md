---
id: feedback-add
kind: command
category: feedback
title: feedback add
symbol: supabase feedback add
summary: Send feedback to the Supabase team
usage: supabase feedback add [message] ... [flags]
description: Send quick feedback about the Supabase CLI to the Supabase team.
parameters:
  - name: message
    location: positional
    required: false
    variadic: true
  - name: --project-ref
    location: flag
    type: string
    description: Project ref to attribute the feedback to (defaults to SUPABASE_PROJECT_ID, then the linked project).
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
    title: Send quick feedback about a papercut in one line
    lang: sh
    code: supabase feedback add "when I run multiple stacks in parallel I get port conflicts"
  - id: example-2
    title: Use -- when the message starts with a dash
    lang: sh
    code: supabase feedback add -- "--yes should be the default in CI"
  - id: example-3
    title: Attribute the feedback to a project from an unlinked directory
    lang: sh
    code: supabase feedback add --project-ref abcdefghijklmnopqrst "branching is slow here"
---
