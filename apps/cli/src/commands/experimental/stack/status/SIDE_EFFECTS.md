# `supabase stack status`

Reports the saved identity and the observed state of a managed local stack.
The command is available when the `experimental.stack` feature flag is enabled.
The top-level `supabase status` command uses this handler when the same flag is
enabled. Routing may read `supabase/config.toml` or `supabase/config.json` to
select the experimental backend; set `SUPABASE_EXPERIMENTAL_STACK=1` to inspect
a stack addressed with `--stack-id` when project configuration is missing or
invalid.

Target selection accepts the current project, `--stack <name>`, or
`--stack-id <id>`. `--stack` and `--stack-id` are mutually exclusive. Explicit
legacy `-o/--output` values are rejected; use `--output-format` instead, or
`--env` in place of the `env` value.

Status reads the persisted stack identity and composition membership, then
observes each service through the saved owner when that owner is reachable. It
never creates, starts, prepares, stops, destroys, or launches an owner for the
ordinary status view. A missing owner is reported as unavailable and its saved
members remain visible without live lifecycle or health values. Lifecycle,
health, endpoint, and aggregate readiness values are reported separately so a
stopped or unhealthy member is distinguishable from an unavailable owner.

The command compares the database version and explicit numeric endpoint ports with the saved
configuration of existing composition members. It does not compare other service settings or
changes to membership; an excluded service is not considered drift. Live listener availability
does not affect this comparison. It reports `config_drift.status` as `unchanged` or
`changed`, with changed paths, when the comparison is possible. A configuration
loading failure or unavailable database observation keeps the saved stack report
available and is shown as `config_drift.status: "unavailable"` with a message in
JSON. Status does not apply current configuration. The `services` list may include
saved standalone instances; composition members identify the services used for
primary database, environment export, and drift comparisons.
The source checkout may bundle the default Functions bootstrap while translating
project configuration for drift; this is in-memory and writes no project files.

Text output includes identity, runtime, owner, lifecycle, readiness, services,
endpoints, and config drift. JSON nests only identity fields under `identity`;
runtime, lifecycle, readiness, composition, services, endpoints, and config
drift remain top-level fields. Stack identity, endpoints, and credentials are
never telemetry properties.

## Exporting environment variables (`--env`)

`--env` is the explicit environment-export operation. It requires a reachable
owner and a running primary database, then derives the database URL from the
observed SQL endpoint and saved database credentials, using the `supabase_admin` role. It does not request live
credentials or launch an owner, and it does not load or compare project
configuration. Text output emits dotenv assignments;
JSON and stream-JSON output emit a plain variable map under a successful result.
Unavailable optional credentials and endpoints are omitted. The derived
`ANON_KEY` and `SERVICE_ROLE_KEY` values are emitted from the required saved database JWT secret.

`--override-name` renames an exported variable, accepting repeated flags or a
comma-separated list of `EXPORTED_VARIABLE=VALID_ENV_NAME` entries. It requires
`--env` and rejects an unknown source variable, duplicate source, invalid target,
malformed entry, or destination collision. Dotenv values that cannot be quoted
without shell expansion fail with a pointer to `--output-format json`.

## Files read and written

The command reads the selected project configuration for ordinary drift
messaging, the CLI's persisted stack state under
`<SUPABASE_HOME or ~/.supabase>/stacks/<id>/`, and the owner's local RPC
endpoint when it exists. `--env` skips project configuration loading. It calls
no management API routes and writes no files besides `telemetry.json`.

Exit status is `0` for a successful report, including a stopped stack or an
absent or unreachable owner, and `130` if interrupted. It is `1` for flag
validation, an unknown target, a typed stack failure, an invalid configuration,
a lifecycle failure during `--env`, or a value that dotenv cannot represent
losslessly. Standard command telemetry is flushed after successful and failed
runs.
