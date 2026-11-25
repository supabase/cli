---
id: logs
kind: command
category: general
title: logs
symbol: supabase logs
summary: Browse local or hosted logs. Arrows select, Enter details, C copies, L loads more logs, and q quits. Custom SQL uses L to rerun. Pipes and machine output read once. Explicit --output-format text disables the viewer. Use --output-format json|stream-json for structured output; -o/--output is unsupported.
usage: supabase logs [subcommand] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --file
    location: flag
    type: string
    description: Read custom hosted log SQL from a file; use - to read stdin.
  - name: --from
    location: flag
    type: string
    description: Start at a UTC timestamp ending in Z.
  - name: --kind
    location: flag
    type: "[ app | requests | builds ]"
    description: Compute stream; requires --service compute.
    allowed_values:
      - app
      - requests
      - builds
  - name: --level
    location: flag
    type: string
    description: Severity filter; repeat for several levels.
    allowed_values:
      - error
      - warn
      - warning
      - info
      - debug
      - log
      - notice
    variadic: true
  - name: --limit
    location: flag
    type: int
    description: Initial filtered history count (default 100, maximum 1000). SQL controls its own LIMIT.
    default: "100"
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target a remote log source: the linked project, or --remote=<ref|branch>."
    default: false
  - name: --resource
    location: flag
    type: string
    description: Compute name or function ID remotely, or a local instance ID.
  - name: --search
    location: flag
    type: string
    description: Case-insensitive message substring (hosted only).
  - name: --service
    location: flag
    type: strings
    description: Service selector; repeat for multiple services. See logs sources.
    variadic: true
  - name: --since
    location: flag
    type: string
    description: Duration or UTC timestamp; defaults to 1h. Local stacks also accept start.
  - name: --sql
    location: flag
    type: string
    description: Custom hosted log SQL; requires --remote. L reruns the query.
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name.
  - name: --stack-id
    location: flag
    type: string
    description: Select a local stack by ID.
  - name: --to
    location: flag
    type: string
    description: Initial end at a UTC timestamp ending in Z. L advances to now.
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

Browse local or hosted logs. Arrows select, Enter details, C copies, L loads more logs, and q quits. Custom SQL uses L to rerun. Pipes and machine output read once. Explicit --output-format text disables the viewer. Use --output-format json|stream-json for structured output; -o/--output is unsupported.
