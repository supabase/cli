---
id: start
kind: command
category: General
title: start
symbol: supabase start
summary: Start the local Supabase stack
usage: supabase start [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --exclude
    location: flag
    type: strings
    description: Containers to skip, as repeated flags or a comma-separated list. [gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor]
    short: -x
    variadic: true
  - name: --ignore-health-check
    location: flag
    type: boolean
    description: Ignore unhealthy services and exit 0.
    default: false
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase start
    response: |
      Creating custom roles supabase/roles.sql...
      Applying migration 20220810154536_employee.sql...
      Seeding data supabase/seed.sql...
      Started supabase local development setup.
  - id: without-studio
    title: Start containers without studio and imgproxy
    lang: sh
    code: supabase start -x studio,imgproxy
    response: |
      Excluding container: supabase/studio:20221214-4eecc99
      Excluding container: darthsim/imgproxy:v3.8.0
      Started supabase local development setup.
  - id: ignore-health-check
    title: Ignore service health checks
    lang: sh
    code: supabase start --ignore-health-check
    response: |
      service not healthy: [supabase_storage_cli]
      Started supabase local development setup.
---

Runs the Supabase local development stack (Postgres, Auth, Storage, Studio, and more) in Docker. Requires a `supabase/config.toml`, which `supabase init` creates.

All service containers start by default. Skip the ones you don't need with `-x`, either as a comma-separated list such as `-x gotrue,imgproxy` or by repeating the flag.

> Starting all services needs at least 7GB of RAM.

The CLI health-checks the started containers. Pass `--ignore-health-check` to continue past unhealthy services.

> If the CLI runs inside a dev container with the Docker socket bind-mounted, set `SUPABASE_SERVICES_HOSTNAME` to a hostname reachable from inside that container, such as `host.docker.internal`.
