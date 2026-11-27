---
id: gen-types
kind: command
category: gen
title: gen types
symbol: supabase gen types
summary: Generate types from Postgres schema
usage: supabase gen types [flags]
description: Generate types from Postgres schema.
parameters:
  - name: --lang
    location: flag
    type: "[ typescript | go | python | swift | dart ]"
    description: Output language of the generated types.
    default: typescript
    allowed_values:
      - typescript
      - go
      - python
      - swift
      - dart
  - name: --query-timeout
    location: flag
    type: string
    description: Maximum timeout allowed for the database query.
    default: 15s
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
  - name: --swift-access-control
    location: flag
    type: "[ internal | public ]"
    description: Access control for Swift generated types.
    default: internal
    allowed_values:
      - internal
      - public
  - name: --swift-typegen-source
    location: flag
    type: string
    description: "Where to build supabase-typegen from: a supabase-swift version (3.0.0-alpha.1), a branch (main), a full commit SHA, or a local checkout (./supabase-swift). Default: the supabase-swift pin in the nearest Package.resolved, else the latest 3.x release."
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
    title: Generate types from the local dev database
    lang: sh
    code: supabase gen types
  - id: example-2
    title: Generate Go types from the linked project
    lang: sh
    code: supabase gen types --lang=go --remote
  - id: example-3
    title: Generate types from a project ref with specific schemas
    lang: sh
    code: supabase gen types --schema public --schema private --remote=abcdefghijklmnopqrst
  - id: example-4
    title: Generate types from a database URL
    lang: sh
    code: supabase gen types --schema public --schema auth --remote='postgresql://...'
---
