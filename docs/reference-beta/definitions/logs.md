---
id: logs
kind: command
category: logs
title: logs
symbol: supabase logs
summary: Browse local or hosted logs. Arrows select, Enter details, C copies, L loads more logs, and q quits. Custom SQL uses L to rerun. Pipes and machine output read once. Explicit --output-format text disables the viewer. Use --output-format json|stream-json for structured output; -o/--output is unsupported.
usage: supabase logs [subcommand] [flags]
description: Browse local or hosted logs. Arrows select, Enter details, C copies, L loads more logs, and q quits. Custom SQL uses L to rerun. Pipes and machine output read once. Explicit --output-format text disables the viewer. Use --output-format json|stream-json for structured output; -o/--output is unsupported.
parameters:
  - name: subcommand
    location: positional
    required: false
  - name: --file
    location: flag
    type: string
    description: Read custom hosted log SQL from a file; use - to read stdin.
    default: ""
  - name: --from
    location: flag
    type: string
    description: Start at a UTC timestamp ending in Z.
    default: ""
  - name: --kind
    location: flag
    type: "[ app | requests | builds ]"
    description: Compute stream; requires --service compute.
    default: ""
    allowed_values:
      - app
      - requests
      - builds
  - name: --level
    location: flag
    type: string
    description: Severity filter; repeat for several levels.
    default: "[]"
    allowed_values:
      - error
      - warn
      - warning
      - info
      - debug
      - log
      - notice
  - name: --limit
    location: flag
    type: int
    description: Initial filtered history count (maximum 1000). SQL controls its own LIMIT.
    default: "100"
  - name: --remote
    location: flag
    type: ref|branch
    description: "Target a remote log source: the linked project, or `--remote=<ref|branch>`."
    default: "false"
  - name: --resource
    location: flag
    type: string
    description: Compute name or function ID remotely, or a local instance ID.
    default: ""
  - name: --search
    location: flag
    type: string
    description: Case-insensitive message substring (hosted only).
    default: ""
  - name: --service
    location: flag
    type: strings
    description: Service selector; repeat for multiple services. See logs sources.
    default: "[]"
  - name: --since
    location: flag
    type: string
    description: Duration or UTC timestamp; defaults to 1h. Local stacks also accept start.
    default: ""
  - name: --sql
    location: flag
    type: string
    description: Custom hosted log SQL; requires --remote. L reruns the query.
    default: ""
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
    default: ""
  - name: --to
    location: flag
    type: string
    description: Initial end at a UTC timestamp ending in Z. L advances to now.
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
    title: Browse hosted Postgres errors
    lang: sh
    code: supabase logs --remote --service postgres --level error --since 30m
  - id: example-2
    title: Read plain text once
    lang: sh
    code: supabase logs --remote --service auth --search "invalid token" --output-format text
  - id: example-3
    title: Export full records as JSON
    lang: sh
    code: supabase logs --remote --service postgres --output-format json
  - id: example-4
    title: Query hosted logs with SQL from stdin
    lang: sh
    code: cat errors.sql | supabase logs --remote --file - --output-format json
---
