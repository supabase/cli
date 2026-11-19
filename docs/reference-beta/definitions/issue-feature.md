---
id: issue-feature
kind: command
category: issue
title: issue feature
symbol: supabase issue feature
summary: Open a feature request
usage: supabase issue feature [flags]
description: Open a GitHub feature request with useful context prefilled.
parameters:
  - name: --additional-context
    location: flag
    type: string
    description: Extra context to prefill on the issue form.
    default: ""
  - name: --alternatives
    location: flag
    type: string
    description: Alternatives considered.
    default: ""
  - name: --area
    location: flag
    type: string
    description: Affected CLI area.
    default: ""
  - name: --existing-issues
    location: flag
    type: boolean
    description: Prefill the existing issues checklist.
    default: "false"
  - name: --no-browser
    location: flag
    type: boolean
    description: Print the issue form URL without opening a browser.
    default: "false"
  - name: --problem
    location: flag
    type: string
    description: Problem the feature should solve.
    default: ""
  - name: --proposed-solution
    location: flag
    type: string
    description: Proposed solution.
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
    title: Open a prefilled feature request
    lang: sh
    code: supabase issue feature --existing-issues --problem "I need to rotate local secrets" --proposed-solution "Add a secrets rotate command"
---
