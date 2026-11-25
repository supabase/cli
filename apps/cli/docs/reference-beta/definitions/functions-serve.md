---
id: functions-serve
kind: command
category: edge-functions
subcategory: functions
title: functions serve
symbol: supabase functions serve
summary: Serve Edge Functions locally
usage: supabase functions serve [Function name] ... [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --env-file
    location: flag
    type: string
    description: Path to an env file that overrides `supabase/functions/.env` and per-function `.env` files.
  - name: --import-map
    location: flag
    type: string
    description: Path to an import map file.
  - name: --inspect
    location: flag
    type: boolean
    description: Alias of `--inspect-mode brk`.
    default: false
  - name: --inspect-main
    location: flag
    type: boolean
    description: Allow inspecting the main worker; requires an inspect flag.
    default: false
  - name: --inspect-mode
    location: flag
    type: "[ run | brk | wait ]"
    description: Activate the inspector in the given mode for debugging.
    allowed_values:
      - run
      - brk
      - wait
  - name: --no-verify-jwt
    location: flag
    type: boolean
    description: Disable JWT verification for the functions.
    default: false
examples:
  - id: example-1
    title: Serve all functions locally
    lang: sh
    code: supabase functions serve
  - id: example-2
    title: Serve with a custom env file
    lang: sh
    code: supabase functions serve --env-file .env.local
  - id: example-3
    title: Serve with the inspector paused at the first line
    lang: sh
    code: supabase functions serve --inspect-mode brk
---

Run all Edge Functions in `supabase/functions` locally, so you can test them before deploying.

The command includes flags for debugging through the V8 inspector protocol, which works with Chrome DevTools, VS Code and IntelliJ IDEA. See the [debugging guide](/docs/guides/functions/debugging-tools) for setup instructions.

1. `--inspect`
   - Alias of `--inspect-mode brk`.

2. `--inspect-mode [ run | brk | wait ]`
   - Activates the inspector.
   - `run` allows a connection without additional behavior. It is not ideal for short scripts, but is useful for long-running scripts where you occasionally want to set breakpoints.
   - `brk` behaves like `run`, and also sets a breakpoint at the first line to pause execution before any code runs.
   - `wait` behaves like `brk`, but pauses execution until an inspector session connects instead of setting a breakpoint.

3. `--inspect-main`
   - Can only be used when one of the above two flags is enabled.
   - Creating an inspector session for the main worker is not allowed by default; this flag allows it.
   - Other behavior follows the `inspect-mode` flag.

You can also customize the inspector under the `edge_runtime` section of `supabase/config.toml`:

1. `inspector_port`
   - The port the inspector session listens on. Defaults to 8083.
2. `policy`
   - How the edge runtime forwards incoming HTTP requests to the worker.
   - `per_worker` allows multiple requests to be forwarded to a worker that already exists.
   - `oneshot` forces the worker to process a single request and then exit. This is useful when debugging, because your changes take effect immediately.
