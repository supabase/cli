# `supabase stack status`

Reports the persisted identity and current owner state of a managed local stack.
The command is read-only: it never creates, starts, prepares, stops, or destroys
a stack, and opens a stack handle only when `--env` is used.
The command is available only when the `experimental.stack` feature flag is
enabled. The top-level `supabase status` command uses this handler when the
same flag is enabled. Command routing may read `supabase/config.toml` or
`supabase/config.json` to select the experimental backend; set
`SUPABASE_EXPERIMENTAL_STACK=1` to inspect a stack addressed with `--stack-id`
when project configuration is missing or invalid.

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
endpoints, and config drift. JSON output nests only the identity fields under
`identity`; runtime, lifecycle, readiness, endpoints, and config drift remain
top-level fields.

When a running stack has a capability transitioning through `stopping`, readiness is reported as
`stopping`. A failed capability takes precedence and reports `degraded`; otherwise readiness
reports `starting`, `stopped`, `dormant`, or `ready` according to the live capability states.

## Exporting environment variables (`--env`)

`--env` opens the target stack, requires it to be running, and exports its
connection URLs and credentials instead of the ordinary identity/drift report.
It does not load or compare project configuration. Text output emits dotenv
assignments, quoting each value with single quotes, or with double quotes when
the value contains a single quote but none of `"`, `\`, `$`, backtick, or `!`,
so sourcing the file in a shell performs no expansion. Any other value, or one
containing a carriage return, fails the command with a pointer to
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

Without `--env`, the command reads the selected `supabase/config.toml` or
`supabase/config.json` and the project dotenv files and environment overrides
the shared config loader consults to resolve the target stack's configuration;
with `--env`, it skips config loading entirely. Either way, it
reads the target stack's persisted state under
`<SUPABASE_HOME or ~/.supabase>/managed/stacks/<id>/`, and when a live owner
exists, it reads the owner's local RPC endpoint for status and credentials.
The command calls no API routes and writes no files besides `telemetry.json`.
It reads the CLI's usual home, workdir, and experimental routing variables,
plus the environment variables used as project configuration overrides.

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
