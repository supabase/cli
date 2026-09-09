# `supabase experimental stack start`

This command creates or resumes the managed stack identified by the current
project and optional `--stack`, or opens an existing stack with `--stack-id`.
It loads `supabase/config.toml` for the target project and resolves explicit
`env(NAME)` references from the project environment. Automatic `SUPABASE_*`
overrides for config sections are not applied: set those fields in
`supabase/config.toml` or use an explicit `env(NAME)` reference instead.
The `@supabase/stack` Effect API owns persistent state, the detached
Supervisor, runtime resources, readiness, and cleanup. The CLI only resolves
the project configuration and renders the resulting status.

`SUPABASE_HOME` controls the package's durable stack state through its normal
runtime composition boundary. The stack owner is deliberately detached from
the command waiter, so returning from a successful start leaves the stack
running for later commands. An interrupted start is handled by the package's
owner cleanup contract.

The config loader reads the project environment files used for config
resolution, including the shared `supabase/.env` and `supabase/.env.local`
files when applicable. Function environment settings additionally read the
shared `supabase/functions/.env` and each enabled function's
`supabase/functions/<name>/.env`; per-function values override shared values.
Encrypted values are rejected with a targeted configuration error. The CLI does
not perform dotenvx decryption.

Text output includes the stack id, lifecycle, endpoints, and dormant
capabilities. Structured output includes the same status fields. The command reads configured
credentials and function/provider secrets to pass them to the stack runtime, but
never emits those values.

`--stack` and `--stack-id` are mutually exclusive. `--runtime auto` uses the
package default; `docker` selects the Docker container runtime; `native`
selects the native runtime. `--preparation` controls background versus
on-demand artifact preparation, and `--eager` requests enabled capabilities be
activated before the command returns.

The command owns only the start request. Once the package reports readiness,
the detached stack owner remains alive after the CLI process exits. If the CLI
caller is interrupted while waiting, the package's owner lifecycle decides
whether the start can complete or must clean up; the CLI does not call stop or
destroy as a cancellation handler.

Database `network_restrictions`, `ssl_enforcement`, and `vault` settings are
accepted by the project config model but are not implemented by the local
runtime and are not forwarded. They do not enforce database security for this
command.

Telemetry state is flushed to `<SUPABASE_HOME or ~/.supabase>/telemetry.json`
after both successful and failed command runs.
