---
id: projects-create
kind: command
category: projects
title: projects create
symbol: supabase projects create
summary: Create a project
usage: supabase projects create [name] [flags]
description: Create a project on Supabase.
parameters:
  - name: name
    location: positional
    required: false
  - name: --db-password
    location: flag
    type: string
    description: Database password of the project.
    default: ""
  - name: --high-availability
    location: flag
    type: boolean
    description: Enable high availability for the project.
    default: "false"
  - name: --org-id
    location: flag
    type: string
    description: Organization ID to create the project in.
    default: ""
  - name: --region
    location: flag
    type: string
    description: Select a region close to you for the best performance.
    default: ""
    allowed_values:
      - ap-east-1
      - ap-northeast-1
      - ap-northeast-2
      - ap-south-1
      - ap-southeast-1
      - ap-southeast-2
      - ca-central-1
      - eu-central-1
      - eu-central-2
      - eu-north-1
      - eu-west-1
      - eu-west-2
      - eu-west-3
      - sa-east-1
      - us-east-1
      - us-east-2
      - us-west-1
      - us-west-2
  - name: --size
    location: flag
    type: string
    description: Select a desired instance size for your project.
    default: ""
    allowed_values:
      - large
      - medium
      - micro
      - 12xlarge
      - 16xlarge
      - 24xlarge
      - 24xlarge_high_memory
      - 24xlarge_optimized_cpu
      - 24xlarge_optimized_memory
      - 2xlarge
      - 48xlarge
      - 48xlarge_high_memory
      - 48xlarge_optimized_cpu
      - 48xlarge_optimized_memory
      - 4xlarge
      - 8xlarge
      - small
      - xlarge
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
    title: Create a new project
    lang: sh
    code: supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1
---
