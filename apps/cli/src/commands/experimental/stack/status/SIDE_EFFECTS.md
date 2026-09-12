# `supabase stack status`

Reports the persisted identity and current owner state of a managed local stack.
The command is read-only: it never creates, starts, prepares, stops, or destroys
a stack, and opens a stack handle only when `--env` is used.

Target selection accepts the current project, `--stack <name>`, or
`--stack-id <id>`. `--stack` and `--stack-id` are mutually exclusive. Any
explicit legacy `-o/--output` value is rejected; use `--output-format` instead,
or `--env` in place of the `env` value.

When the project configuration loads and the comparison accepts it, status
includes redacted config drift paths. An absent `supabase/config.toml` is
compared using default settings, matching `supabase stack start`. Drift output
contains statuses and paths only; secret values are never emitted.

When the configuration cannot be loaded at all, the warning is `Project
configuration could not be loaded; fix it before checking drift.` When it
loads but the comparison rejects it, such as an invalid stack config or an
unsupported version, the warning is `Project configuration could not be
compared: <typed diagnostic>`. Either warning leaves the persisted stack
inspection available, appears as `Config warning:` in text output, and as
`config_drift.message` with `status: "unavailable"` in JSON.

Text output includes identity, runtime, owner, lifecycle, readiness,
endpoints, and config drift. JSON output contains the same fields under
`identity`.

## Exporting environment variables (`--env`)

`--env` opens the target stack, requires it to be running, and exports its
connection URLs and credentials instead of the ordinary identity/drift report.
It does not load or compare project configuration. Text output emits dotenv
assignments, quoting each value with single quotes, double quotes, or
backticks, choosing the first that round-trips; a value containing all three
quote kinds, or a backslash together with both a single quote and a backtick,
or a carriage return, fails the command with a pointer to
`--output-format json`. JSON and stream-JSON output, including automatic agent
detection, emit a plain variable map under a successful result. As described
above, the legacy `-o env` value is rejected with guidance to use `--env`.

The exported variables are `DB_URL`, `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
`PUBLISHABLE_KEY`, `SECRET_KEY`, `STUDIO_URL`, `INBUCKET_URL`,
`S3_PROTOCOL_ACCESS_KEY_ID`, `S3_PROTOCOL_ACCESS_KEY_SECRET`,
`S3_PROTOCOL_REGION`, and `S3_PROTOCOL_URL`. `ANON_KEY`, `SERVICE_ROLE_KEY`,
`PUBLISHABLE_KEY`, and `SECRET_KEY` are omitted when the stack's Auth capability
is disabled. `API_URL`, `STUDIO_URL`, `INBUCKET_URL`, and the `S3_PROTOCOL_*`
variables are omitted when the corresponding endpoint or storage credentials are
unavailable. Values always come from the running stack; none are invented.

`--override-name` renames an exported variable, accepting repeated flags or a
comma-separated list of `EXPORTED_VARIABLE=VALID_ENV_NAME` entries. It requires
`--env` and rejects an unknown source variable, a source variable listed more
than once, an invalid target name, a missing or malformed entry, and a rename
that collides with another exported variable's name.

Ordinary status (without `--env`) never opens a stack handle and never emits
credentials, regardless of the stack's lifecycle. A stopped stack or a
credentials failure with `--env` fails the command without emitting output.

## Files read and written

Without `--env`, the command reads `supabase/config.toml` and the project
dotenv files the shared config loader consults to resolve the target stack's
configuration; with `--env`, it skips config loading entirely. Either way, it
reads the target stack's persisted state under
`<SUPABASE_HOME or ~/.supabase>/managed/stacks/<id>/`, and when a live owner
exists, it reads the owner's local RPC endpoint for status and credentials.
The command calls no API routes and writes no files besides `telemetry.json`.
It reads no environment variables beyond the CLI's usual `SUPABASE_HOME`,
`SUPABASE_WORKDIR`, and `SUPABASE_EXPERIMENTAL_STACK` routing.

## Output and telemetry

Exit status is `0` for a successful report, including a stopped stack or an
absent or unreachable owner, and `130` if the command is interrupted. It is
`1` for a flag validation failure (`--stack` with `--stack-id`, any legacy
`-o/--output` value, `--override-name` without `--env` or with an unknown
source, an invalid target name, a duplicate source, or a colliding
destination), for no stack in the current context or an unknown `--stack-id`,
for a typed stack failure, for `--env` against a stack that is not running, or
for a value that dotenv cannot represent losslessly.

Standard command instrumentation (`withCommandTelemetry`) records command
metadata and flag presence; stack identity, endpoints, and credentials are
never telemetry properties.

Telemetry state is flushed to `<SUPABASE_HOME or ~/.supabase>/telemetry.json`
after both successful and failed command runs.
