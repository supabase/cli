# `supabase stack status`

Reports the persisted identity and current owner state of a managed local stack.
The command is read-only: it never creates, starts, prepares, stops, or destroys
a stack, and opens a stack handle only when `--env` is used.

Target selection accepts the current project, `--stack <name>`, or
`--stack-id <id>`. `--stack` and `--stack-id` are mutually exclusive. An explicit
legacy `-o/--output` flag is rejected; use `--output-format json` for structured
output.

When the project configuration can be loaded, status includes redacted config
drift paths. An absent `supabase/config.toml` is compared using default
settings, matching `supabase stack start`. An invalid or unreadable
configuration is reported as a warning while the persisted stack inspection
remains available. Drift output contains statuses and paths only; secret
values are never emitted.

Text output includes identity, runtime, owner, lifecycle, readiness, endpoints,
and config drift. JSON output contains the same fields under `identity`, with
the warning carried in `config_drift.message` when drift is `unavailable`.

## Exporting environment variables (`--env`)

`--env` opens the target stack, requires it to be running, and exports its
connection URLs and credentials instead of the ordinary identity/drift report.
It does not load or compare project configuration. Text output emits dotenv
assignments; JSON and stream-JSON output, including automatic agent detection,
emit a plain variable map under a successful result. The legacy `-o env` form
is rejected; use `--env` instead.

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
`--env` and rejects an unknown source variable, an invalid target name, a
missing or malformed entry, and a rename that collides with another exported
variable's name.

Ordinary status (without `--env`) never opens a stack handle and never emits
credentials, regardless of the stack's lifecycle. A stopped stack or a
credentials failure with `--env` fails the command without emitting output.
