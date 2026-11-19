---
id: issue-bug
kind: command
category: issue
title: issue bug
symbol: supabase issue bug
summary: Open a bug report
usage: supabase issue bug [flags]
description: Open a GitHub bug report with local CLI details prefilled.
parameters:
  - name: --actual-output
    location: flag
    type: string
    description: Actual output or error text.
    default: ""
  - name: --additional-context
    location: flag
    type: string
    description: Extra context to prefill on the issue form.
    default: ""
  - name: --area
    location: flag
    type: string
    description: Affected CLI area.
    default: ""
  - name: --command
    location: flag
    type: string
    description: Command that failed.
    default: ""
  - name: --crash-report-id
    location: flag
    type: string
    description: Crash report or support ticket ID, if you have one.
    default: ""
  - name: --docker-services
    location: flag
    type: string
    description: Relevant Docker service status or logs.
    default: ""
  - name: --expected-behavior
    location: flag
    type: string
    description: Expected behavior.
    default: ""
  - name: --no-browser
    location: flag
    type: boolean
    description: Print the issue form URL without opening a browser.
    default: "false"
  - name: --reproduce
    location: flag
    type: string
    description: Steps to reproduce.
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
    title: Open a prefilled bug report for a failing command
    lang: sh
    code: supabase issue bug --command "supabase start" --actual-output "database failed to start"
  - id: example-2
    title: Print a prefilled issue URL with a crash report ID
    lang: sh
    code: supabase issue bug --crash-report-id "abc123" --no-browser
---
