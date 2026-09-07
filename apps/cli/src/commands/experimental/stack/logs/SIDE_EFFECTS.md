# `supabase experimental stack logs`

This command reads retained logs from the managed stack identified by the current project,
an optional `--stack` name, or `--stack-id`. It calls the public `@supabase/stack` logs
and followLogs APIs without loading `supabase/config.toml`, starting the stack, stopping it,
or changing its owner lifecycle.

## Files read and written

The stack package reads its normal durable state under `<SUPABASE_HOME or ~/.supabase>` and
the selected stack's persisted log state. The CLI reads the current workdir from its normal
settings resolution. This command writes no project files, stack state, credentials, or
runtime resources.

## Output

Text mode writes one line per retained or followed entry. JSON mode writes one bounded result;
`--follow` is rejected with `--output-format json`; use the default text mode or
`--output-format stream-json`, which emits one `log-entry` event per line.
Follow prints the retained history first and then resumes from its returned cursor. If the stack
is already stopped, it prints the retained history and exits successfully. Interrupting follow
cancels the log reader, exits with status `130`, and leaves the managed stack owner untouched.

## Telemetry

The command uses the standard command instrumentation wrapper. Stack log contents and messages
are not sent as custom telemetry properties.
