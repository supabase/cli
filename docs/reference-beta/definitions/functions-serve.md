---
id: functions-serve
kind: command
category: functions
title: functions serve
symbol: supabase functions serve
summary: Serve all Functions locally
usage: supabase functions serve [Function name] ... [flags]
description: |-
  Serve all Functions locally.

  `supabase functions serve` command includes additional flags to assist developers in debugging Edge Functions via the v8 inspector protocol, allowing for debugging via Chrome DevTools, VS Code, and IntelliJ IDEA for example. Refer to the [docs guide](/docs/guides/functions/debugging-tools) for setup instructions.

  1. `--inspect`
     - Alias of `--inspect-mode brk`.

  2. `--inspect-mode [ run | brk | wait ]`
     - Activates the inspector capability.
     - `run` mode simply allows a connection without additional behavior. It is not ideal for short scripts, but it can be useful for long-running scripts where you might occasionally want to set breakpoints.
     - `brk` mode same as `run` mode, but additionally sets a breakpoint at the first line to pause script execution before any code runs.
     - `wait` mode similar to `brk` mode, but instead of setting a breakpoint at the first line, it pauses script execution until an inspector session is connected.

  3. `--inspect-main`
     - Can only be used when one of the above two flags is enabled.
     - By default, creating an inspector session for the main worker is not allowed, but this flag allows it.
     - Other behaviors follow the `inspect-mode` flag mentioned above.

  Additionally, the following properties can be customized via `supabase/config.toml` under `edge_runtime` section.

  1. `inspector_port`
     - The port used to listen to the Inspector session, defaults to 8083.
  2. `policy`
     - A value that indicates how the edge-runtime should forward incoming HTTP requests to the worker.
     - `per_worker` allows multiple HTTP requests to be forwarded to a worker that has already been created.
     - `oneshot` will force the worker to process a single HTTP request and then exit. (Debugging purpose, This is especially useful if you want to reflect changes you've made immediately.)
parameters:
  - name: Function name
    location: positional
    required: false
    variadic: true
  - name: --env-file
    location: flag
    type: string
    description: Path to an env file. Overrides supabase/functions/.env and per-Function .env files.
    default: ""
  - name: --import-map
    location: flag
    type: string
    description: Path to import map file.
    default: ""
  - name: --inspect
    location: flag
    type: boolean
    description: Alias of --inspect-mode brk.
    default: "false"
  - name: --inspect-main
    location: flag
    type: boolean
    description: Allow inspecting the main worker.
    default: "false"
  - name: --inspect-mode
    location: flag
    type: "[ run | brk | wait ]"
    description: Activate inspector capability for debugging.
    default: ""
    allowed_values:
      - run
      - brk
      - wait
  - name: --no-verify-jwt
    location: flag
    type: boolean
    description: Disable JWT verification for the Function.
    default: "false"
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
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
examples: []
---
