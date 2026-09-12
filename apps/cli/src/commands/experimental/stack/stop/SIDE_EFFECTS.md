# `supabase stack stop`

This command stops the managed stack identified by the current project, an optional `--stack`
name, or `--stack-id`. With `--all`, it discovers every readable managed stack and attempts each
stop while preserving persistent state and data volumes. `--all` cannot be combined with a named
stack or `--stack-id`; the command never destroys stacks.

## Files read and written

The stack package reads and updates its durable state under `<SUPABASE_HOME or ~/.supabase>`
and the selected stack's lifecycle state. The CLI reads its normal workdir settings. The
command does not load `supabase/config.toml`, so a missing or invalid project config does not
prevent stopping a stack addressed with `--stack-id`. Implicit and named stacks still depend on
workdir discovery, so removing an ancestor config can change which stack is selected; use an
explicit `--workdir` when needed.

No project files, credentials, or runtime configuration files are written. The package owns
the supervisor teardown and state transition; the CLI does not remove containers, volumes,
or stack state itself. If persisted state says the stack is running but its owner is
unreachable, the package may launch a short-lived Supervisor to arbitrate teardown before
returning. That process is package-owned and is not managed directly by the CLI.

## Output and telemetry

Text mode reports the selected stack and stopped outcome. A successful single-stack JSON response is
`{ "found": true, "id": "<stack-id>", "lifecycle": "stopped", "message": "" }`; when no current
stack exists it is `{ "found": false, "message": "No managed stack found for this context." }`.
A successful bulk JSON response is `{ "stopped": ["<stack-id>", ...], "message": "" }`.
Stream-json wraps the same payload in its standard result event. Bulk mode attempts all readable
stacks, warns for unreadable entries, and reports stopped, failed, and skipped counts with per-stack
details. It exits nonzero when an entry is skipped or a stop fails.
The `--all` flag is presence-sensitive for target validation, so `--all=false` still conflicts with
`--stack` and `--stack-id`; `--all=false` alone uses single-stack mode.
Registry-root enumeration failures remain fatal. Exit status is `0` for a successful stop or no
current stack, `1` for a missing named stack or any typed stop failure, and `130` if the command is
interrupted before the stop completes. Standard command instrumentation records command
metadata; stack data and credentials are not emitted as telemetry properties.

Telemetry state is flushed to `<SUPABASE_HOME or ~/.supabase>/telemetry.json`
after both successful and failed command runs.
