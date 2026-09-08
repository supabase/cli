# `supabase stack status`

Reports the persisted identity and current owner state of a managed local stack.
The command is read-only: it never creates, starts, prepares, stops, or destroys a stack. With `--env`, it opens a read-only stack handle to retrieve
current status and credentials.

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
`config_drift` and a warning message in `config_drift` when configuration could
not be loaded. Drift compares the persisted effective stack definition with the
configuration-derived candidate, so explicit start policies such as `--eager`
or `--preparation on-demand` remain visible as intentional policy drift on a
later status check.

`--env` exports the selected running stack’s connection variables. Text output
is dotenv content; `--output-format json` and `stream-json` return a variable map.
`--override-name API_URL=NEXT_PUBLIC_SUPABASE_URL` renames an exported variable;
it supports CSV and repeated values, requires `--env`, and rejects unknown
source names, invalid environment names, and duplicate destination names.

Variables are `DB_URL`, `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
`PUBLISHABLE_KEY`, `SECRET_KEY`, `STUDIO_URL`, `INBUCKET_URL`,
`S3_PROTOCOL_ACCESS_KEY_ID`, `S3_PROTOCOL_ACCESS_KEY_SECRET`,
`S3_PROTOCOL_REGION`, and `S3_PROTOCOL_URL`. API credentials are omitted when Auth is disabled. Optional service endpoints
and S3 credentials are omitted when unavailable. These values come from the running
stack, never legacy containers or project config. This explicit export reveals
credentials; ordinary status output does not. A stopped stack or credential
retrieval failure produces an error without partial output. Environment export
does not compare project configuration or report drift.
