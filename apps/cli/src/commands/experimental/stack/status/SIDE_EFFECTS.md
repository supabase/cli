# `supabase experimental stack status`

Reports the persisted identity and current owner state of a managed local stack.
The command is read-only: it never creates, starts, prepares, stops, destroys, or
opens a stack handle.

Target selection accepts the current project, `--stack <name>`, or
`--stack-id <id>`. `--stack` and `--stack-id` are mutually exclusive. An explicit
legacy `-o/--output` flag is rejected; use `--output-format json` for structured
output.

When the project configuration can be loaded, status includes redacted config
drift paths. Missing or invalid configuration is reported as a warning while the
persisted stack inspection remains available. Drift output contains statuses and
paths only; secret values are never emitted.

Text output includes identity, runtime, owner, lifecycle, readiness, endpoints,
and config drift. JSON output contains the same fields under `identity`, with
`config_drift` and `config_warning` when available.
