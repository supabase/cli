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
[`src/shared/telemetry/analytics.service.ts`](../src/shared/telemetry/analytics.service.ts),
implemented for the CLI by
[`src/telemetry/analytics.layer.ts`](../src/telemetry/analytics.layer.ts).

It is intentionally separate from the span-based tracing path.

## Command-Scoped Context

The analytics path uses an Effect V4-style scoped context rather than trying to model events as a
span tree.

The core pieces are:

- `CurrentAnalyticsContext`
- `withAnalyticsContext(...)`
- `withCommandTelemetry(...)`

`CurrentAnalyticsContext` is a `Context.Reference` that carries the current analytics context
for the running effect scope.

[`withCommandTelemetry(...)`](../src/telemetry/command-telemetry.ts) wraps command handlers and
installs the command span plus the per-invocation analytics context:

- `command_run_id`
- `command`
- `flags`

That same context is then inherited by milestone events captured inside the command handler, which
lets one CLI invocation share a single `command_run_id`.

The wrapper also rejects the removed global `--create-ticket` flag (with any value) before the
handler runs. The rejection happens inside the instrumented region, so it still emits
`cli_command_executed` with an `error_fingerprint` ending in `:removed_flag`. A command that fails
earlier, such as on a missing credential in its runtime layer, or that shows help, reports that
instead.

## Event Model

The primary analytics event is:

- `cli_command_executed`

It is emitted once per handled command invocation and includes:

- `command`
- `flags`
- `exit_code`
- `duration_ms`
- `output_format`
- `config_format` (`toml`, `json` or `jsonc`) once the command reads the project's config file,
  set on success and on failure, including when the file fails to parse. Commands that never read
  the project config, and projects without one, omit it

Failed invocations (`exit_code != 0`) handled by the TS shells also carry a
sanitized error classification:

- `error_kind`
- `error_category`
- `error_fingerprint`
- `has_suggestion`
- `suggestion_type`
- `suggested_command` (only when the remediation is an allowlisted command)
- `config_key` (only on `invalid_config` failures from config resolution: the failing config key
  path, such as `inbucket` or `auth.email.smtp.port`, comma-joined when several removed keys fail;
  keys only, never values, file paths or user-chosen names, which collapse to their nearest known
  parent key)

Apart from `config_key`, these values come exclusively from the closed taxonomy in
`src/shared/telemetry/error-actionability.ts` — never from raw error text —
and the KPI query semantics (strict recovery, repeat errors, internal/unknown
bug rate) are documented there in `CliErrorActionabilityMetricDefinitions`.
A `workflow` property is reserved in the catalog but not emitted yet.

Not every failure is classified: events from CLI versions before these fields
existed never carry them. KPI queries therefore scope to
`error_kind IS NOT NULL`, and the `classificationCoverage` metric definition
reports the classified share of failures so the covered fraction is explicit
rather than assumed.

Local-runtime commands also carry properties that split error rates by runtime:

- `stack_backend` (`legacy` or `stack`) on commands routed by `experimental.stack`; see
  [backend selection](stack-commands.md)
- `stack_runtime` (`docker`, `podman`, or `native`): the runtime of the stack a stack-backend
  command looked up, which for `--remote=<url>` may be the project stack even when the URL targets
  another database
- `orioledb` (boolean) once the command resolves local database config, `true` when the project
  selects an OrioleDB image (`db.orioledb_version` on a 15/17 project). It describes local config
  only; for `--remote` targets it says nothing about the remote database
- `serve_end_reason` on the Docker-runtime `functions serve`, set once its final outcome is known:
  `signal` (the CLI received a shutdown signal), `container_stopped` (an external supervisor
  stopped the Edge Runtime container, e.g. `supabase stop`), `container_exited` (the container
  exited on its own with code 0), `container_removed` (the container disappeared), or
  `container_crashed` (the container exited with a crash code, which also fails the command). A
  restart records nothing; only the final end does
- `edge_runtime_exit_code` (number) alongside `serve_end_reason` when the container's exit code is
  known: its stop code for `container_stopped`, `0` for `container_exited`, its crash code for
  `container_crashed`

Flag capture is intentionally conservative: `flags` records only flags changed on the command
line, and redacts each value unless it is boolean, a choice flag, or listed in the command's
`safeFlags`.

Current milestone events include:

- `cli_login_completed`
- `cli_project_linked`
- `cli_stack_started`
- `cli_upgrade_suggested`

## Shared Properties and Identity

The analytics layer attaches a base set of properties to every PostHog event:

- `platform: "cli"`
- `schema_version`
- `device_id`
- `$session_id`
- `is_first_run`
- `is_tty`
- `is_ci`
- `is_agent`
- `agent_name` (the detected agent, such as `claude`, `codex`, or `cursor_cli`; only when
  `is_agent` is true)
- `is_eval` (true when `SUPABASE_EVAL` is `1` or `true`, so automated evaluation runs can be
  excluded from usage metrics)
- `env_signals` (allowlisted agent and terminal environment variables, when any are set)
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
