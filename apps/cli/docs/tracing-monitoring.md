# CLI Tracing and Monitoring

This document describes the CLI tracing path: spans, local trace export, and how this
observability path is intended to relate to Sentry.

For product analytics and command usage events, see [analytics.md](./analytics.md).

For where CLI-owned global state lives, including telemetry state under `SUPABASE_HOME`, see
[supabase-home.md](./supabase-home.md).

## Purpose

Tracing answers observability questions such as:

- which command ran
- how long major phases took
- whether the command succeeded or failed
- what happened inside a command span tree

This path is span-based. It is intentionally separate from PostHog analytics, which is event-based
and optimized for product questions rather than operational traces.

The tracing implementation is currently owned by the `Tracing` service and
[`src/telemetry/tracing.layer.ts`](../src/telemetry/tracing.layer.ts).

## What Happens Today

The CLI builds a custom Effect tracer and attaches a fixed set of global attributes to every span:

- `schema_version`
- `device_id`
- `session_id`
- `is_first_run`
- `is_tty`
- `is_ci`
- `os`
- `arch`
- `cli_version`

Commands then use normal Effect tracing primitives such as `Effect.withSpan(...)` and
`Effect.annotateCurrentSpan(...)` to create and enrich spans.

Today, tracing is exported in two ways:

- NDJSON files under `SUPABASE_HOME/traces/`
- optional debug console output when telemetry debug is enabled

The NDJSON exporter is the durable local trace sink. The debug console exporter is only for
interactive inspection while developing or debugging the CLI.

## Consent and State

Tracing follows the shared telemetry consent model used by the CLI:

- consent is user-level CLI state stored in `SUPABASE_HOME/telemetry.json`
- environment overrides can still disable telemetry in CI or sandboxed runs
- consent is not stored in `supabase/config.*`
- consent is not stored in repo-local `.supabase/`

The consent read/write logic lives in [`src/telemetry/consent.ts`](../src/telemetry/consent.ts),
and the runtime view of telemetry state is built in
[`src/telemetry/runtime.layer.ts`](../src/telemetry/runtime.layer.ts).

When consent is not granted, the tracing layer does not initialize the NDJSON exporter. Debug
output is gated separately by the telemetry debug flags.

## Local Storage Layout

The tracing path writes local files under:

```text
SUPABASE_HOME/
  telemetry.json
  traces/
    <date>.ndjson
```

`telemetry.json` stores telemetry state such as consent, device identity, and session identity.
`traces/` stores exported spans.

This keeps monitoring data in machine-global CLI state rather than project config.

## Relation to Sentry

Sentry belongs on the tracing and monitoring side, not the PostHog analytics side.

Current state:

- the CLI already has a span-based tracing path
- that path exports locally to NDJSON
- it is not yet using Sentry as the live exporter

Intended direction:

- Sentry should consume the tracing path as an observability backend
- PostHog should continue to receive curated analytics events separately

That separation matters because traces and analytics solve different problems and have different
volume, retention, and schema needs.

## What Tracing Is Not

Tracing is intentionally not used for:

- product analytics funnels
- command adoption reporting
- organization or project group analytics
- user-facing milestone events such as `cli_login_completed`

Those concerns belong to the analytics path described in [analytics.md](./analytics.md).
