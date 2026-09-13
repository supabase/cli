# `supabase stack destroy`

Permanently stops and removes one managed stack, including its persisted data.

The command targets the current project stack by default, or an explicit `--stack` name or
`--stack-id`. It requires an interactive text terminal on both stdout and stdin for confirmation;
`--yes` is required for redirected, non-interactive, and machine-readable invocations.
`SUPABASE_YES` participates in the existing confirmation setting;
an explicit `--yes=false` overrides it. It never accepts `--all`.

The stack package reads the selected descriptor and removes resources and state under
`${SUPABASE_HOME:-~/.supabase}/managed/stacks/<id>`. It owns stopping the Supervisor, removing
native processes or containers, and deleting persistent stack data. The CLI does not delete paths
or Docker resources itself and makes no Management API calls. Project files are retained.

The confirmation prompt identifies the stack name, project directory, and immutable stack ID.
Rejection or missing noninteractive confirmation performs no destructive operation. Text output
reports the destroyed stack ID. JSON returns
`{ "destroyed": true, "id": "...", "message": "" }`; stream-JSON wraps the same payload in
the standard result event. Success exits `0`; invalid targets, confirmation refusal, and
destruction failures exit `1`; interruption follows the command runtime's interruption exit.
Standard command instrumentation records command metadata without exporting credentials, and
telemetry state flushes after both successful and failed runs.
