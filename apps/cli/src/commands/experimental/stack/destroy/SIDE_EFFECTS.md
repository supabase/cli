# `supabase stack destroy`

Permanently stops and removes one managed new-backend stack, including its persisted data.

The command targets the current project stack by default, or an explicit `--stack` name or
`--stack-id`. It requires interactive confirmation; `--yes` is required for non-interactive and
machine-readable invocations. It never accepts `--all`.

The stack package reads the selected descriptor and removes its resources and
state under `${SUPABASE_HOME:-~/.supabase}/managed/stacks/<id>`. It owns stopping
the supervisor, removing native processes or containers, and deleting the
stack’s persistent data. The CLI does not delete paths or Docker resources
itself and makes no Management API calls. Project files are retained.

The normal CLI settings select the working directory and stack home.
`SUPABASE_YES` participates in the existing confirmation setting; explicit
`--yes=false` overrides it. The prompt identifies the name, project directory,
and immutable stack ID. Rejection or missing noninteractive confirmation
performs no destructive operation.

Text output reports the destroyed stack ID. JSON and stream-JSON return
`{ "destroyed": true, "id": "..." }`. Success exits 0; invalid targets,
confirmation refusal, and destruction failures exit 1. Standard command
instrumentation records command metadata without exporting credentials.
