---
id: link
kind: command
category: link
title: link
symbol: supabase link
summary: Link to a Supabase project
usage: supabase link [ref-or-branch] [flags]
description: |-
  Link your local development project to a hosted Supabase project. Pass the project ref, or the name of one of its branches, as the argument: `supabase link <ref>`. The `--project-ref` flag still works.

  PostgREST configurations are fetched from the Supabase platform and validated against your local configuration file.

  Optionally, database settings can be validated if you provide a password. Your database password is saved in native credentials storage if available.

  > If you do not want to be prompted for the database password, such as in a CI environment, you may specify it explicitly via the `SUPABASE_DB_PASSWORD` environment variable.

  Passing `--remote` to commands like `db dump`, `db push`, and `db pull` targets the linked project, so it must be linked first.
parameters:
  - name: ref-or-branch
    location: positional
    required: false
  - name: --project-ref
    location: flag
    type: string
    description: Project ref of the Supabase project, or the name of one of its branches.
    default: ""
  - name: --skip-pooler
    location: flag
    type: boolean
    description: Use direct connection instead of pooler.
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
    title: Link to a project by ref
    lang: sh
    code: supabase link abcdefghijklmnopqrst
  - id: example-2
    title: Link to a branch of the currently linked project by name
    lang: sh
    code: supabase link my-branch
---
