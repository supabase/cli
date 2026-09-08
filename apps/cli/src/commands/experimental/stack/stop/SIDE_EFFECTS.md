# `supabase stack stop`

This command stops the managed stack identified by the current project, an optional `--stack`
name, or `--stack-id`. It uses the public `@supabase/stack` API to stop the owner while
preserving the stack's persistent state and data volumes. It never destroys the stack.

## Files read and written

The stack package reads and updates its durable state under `<SUPABASE_HOME or ~/.supabase>`
and the selected stack's lifecycle state. The CLI reads its normal workdir settings. The
command does not load `supabase/config.toml`, so a missing or invalid project config does not
prevent stopping an addressed stack.

No project files, credentials, or runtime configuration files are written. The package owns
the supervisor teardown and state transition; the CLI does not remove containers, volumes,
or stack state itself. If persisted state says the stack is running but its owner is
unreachable, the package may launch a short-lived Supervisor to arbitrate teardown before
returning. That process is package-owned and is not managed directly by the CLI.

## Output and telemetry

Text mode reports the selected stack and stopped outcome. Structured modes include the selected
stack id and stopped outcome. If no current stack exists, the command succeeds with an explicit
no-stack result. Exit status is `0` for a successful stop or no current stack, `1` for a
missing named stack or any typed stop failure, and `130` if the command is interrupted before
the stop completes. Standard command instrumentation records command
metadata; stack data and credentials are not emitted as telemetry properties.
