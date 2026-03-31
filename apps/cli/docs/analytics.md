# CLI Analytics

This document describes the CLI analytics path: PostHog event capture, command-scoped analytics
context, identity stitching, and group analytics.

For tracing and monitoring, see [tracing-monitoring.md](./tracing-monitoring.md).

For where CLI-owned global state lives, including telemetry state under `SUPABASE_HOME`, see
[supabase-home.md](./supabase-home.md).

## Purpose

Analytics answers product questions such as:

- which CLI commands are being used
- which flags are commonly supplied
- which milestone actions were completed
- which linked projects or organizations are active
- whether usage came from a human terminal, CI, or known agent tool

This path is event-based and is owned by the PostHog-facing `Analytics` service in
[`src/telemetry/analytics.service.ts`](../src/telemetry/analytics.service.ts) and
[`src/telemetry/analytics.layer.ts`](../src/telemetry/analytics.layer.ts).

It is intentionally separate from the span-based tracing path.

## Command-Scoped Context

The analytics path uses an Effect V4-style scoped context rather than trying to model events as a
span tree.

The core pieces are:

- `CurrentAnalyticsContext`
- `withAnalyticsContext(...)`
- `withCommandAnalytics(...)`

`CurrentAnalyticsContext` is a `ServiceMap.Reference` that carries the current analytics context
for the running effect scope.

`withCommandAnalytics(...)` wraps command handlers and installs per-invocation context such as:

- `command_run_id`
- `command`
- `flags_used`
- `flag_values`

That same context is then inherited by milestone events captured inside the command handler, which
lets one CLI invocation share a single `command_run_id`.

## Event Model

The primary analytics event is:

- `cli_command_executed`

It is emitted once per handled command invocation and includes:

- `command`
- `flags_used`
- `flag_values`
- `exit_code`
- `duration_ms`

Flag capture is intentionally conservative:

- `flags_used` is always captured
- `flag_values` defaults to an empty object
- commands must opt specific flag values in explicitly later if needed

Current milestone events include:

- `cli_login_completed`
- `cli_project_linked`
- `cli_stack_started`

These are emitted from command handlers such as:

- [`src/commands/login/login.handler.ts`](../src/commands/login/login.handler.ts)
- [`src/commands/link/link.handler.ts`](../src/commands/link/link.handler.ts)
- [`src/commands/start/start.handler.ts`](../src/commands/start/start.handler.ts)

## Shared Properties and Identity

The analytics layer attaches a base set of properties to every PostHog event:

- `platform: "cli"`
- `schema_version`
- `device_id`
- `$session_id`
- `is_first_run`
- `is_tty`
- `is_ci`
- `ai_tool`
- `os`
- `arch`
- `cli_version`

Identity is resolved from `SUPABASE_HOME/telemetry.json`:

- `device_id` is the anonymous CLI device identity
- `$session_id` is the current CLI session grouping identifier
- `distinct_id` is optional and is used when the CLI knows the authenticated user identity

At login time, if the auth response includes a `user_id`, the CLI can:

- `alias(device_id -> user_id)`
- `identify(user_id, ...)`
- persist `distinct_id`

That stitching is intentionally best-effort. The current token format is opaque, so the CLI does
not derive the user ID locally from the stored token.

## Group Analytics

When a project is linked, the CLI can also attach PostHog groups for:

- `organization`
- `project`

The linked project snapshot cached in repo-local `.supabase/project.json` includes organization and
project metadata used for this purpose, while the user-level telemetry state remains in
`SUPABASE_HOME/telemetry.json`.

During `supabase link`, the CLI:

- refreshes linked project metadata
- calls `groupIdentify()` for organization and project
- emits `cli_project_linked`
- uses scoped analytics context so later captures in the same invocation can reuse those groups

For later commands, the analytics layer can also derive groups from the cached linked project
state when available.

## Consent and State

Analytics follows the shared CLI telemetry consent model:

- telemetry state is stored under `SUPABASE_HOME/telemetry.json`
- project `supabase/config.*` does not store telemetry consent
- repo-local `.supabase/` does not store telemetry consent
- environment overrides can still disable telemetry in CI or sandboxed runs, primarily
  `SUPABASE_TELEMETRY_DISABLED=1`

The CLI also honors `DO_NOT_TRACK=1` as a broader system-level opt-out signal.

The telemetry commands:

- `supabase telemetry enable`
- `supabase telemetry disable`
- `supabase telemetry status`

read and update that same `telemetry.json` file.

## Comparison: Vercel CLI

This layout is intentionally similar to the Vercel CLI in one important way: telemetry consent is
treated as global CLI state, not project config.

Vercel persists telemetry choice in a user-level global config file rather than `vercel.json`.
The Supabase CLI follows the same high-level rule:

- telemetry choice belongs under `SUPABASE_HOME`
- telemetry choice does not belong in repo-local project config

The main difference is storage shape.

Vercel stores a simple `telemetry.enabled` flag inside its broader global config. The Supabase CLI
uses a dedicated `telemetry.json` file because analytics state also carries runtime-owned identity
and session fields such as:

- `device_id`
- `session_id`
- `session_last_active`
- optional `distinct_id`

That makes a dedicated telemetry file a better fit for the current CLI design than folding these
fields into a more generic global config structure.

For environment-based opt-out, the Supabase CLI follows the same naming convention as Vercel:

- `SUPABASE_TELEMETRY_DISABLED=1`

## PostHog Role

PostHog is the product analytics sink for curated CLI events. It is not treated as a trace backend.

That means:

- analytics gets one or a few meaningful events per command
- traces remain in the tracing path
- Sentry and PostHog remain distinct telemetry systems with different responsibilities

In short:

- tracing/monitoring: spans and observability
- analytics/PostHog: product events and usage analysis
