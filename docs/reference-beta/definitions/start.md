---
id: start
kind: command
category: start
title: start
symbol: supabase start
summary: Start local Supabase stack
usage: supabase start [flags]
description: |-
  Starts the Supabase local development stack.

  Requires `supabase/config.toml` to be created in your current working directory by running `supabase init`.

  All service containers are started by default. The `-x` flag accepts comma-separated service names or repeated occurrences.

  > It is recommended to have at least 7GB of RAM to start all services.

  Health checks are automatically added to verify the started containers. Use `--ignore-health-check` flag to ignore these errors.

  > If the CLI is running inside a dev container with the Docker socket bind-mounted, set the `SUPABASE_SERVICES_HOSTNAME` environment variable to the hostname reachable from inside that container, such as `host.docker.internal`.
parameters:
  - name: --exclude
    location: flag
    type: strings
    description: Names of containers to not start. [gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor]
    short: -x
    default: "[]"
  - name: --ignore-health-check
    location: flag
    type: boolean
    description: Ignore unhealthy services and exit 0
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
examples: []
---
