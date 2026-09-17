# `supabase stack logs`

This command is available only when the `experimental.stack` feature flag is enabled. It reads
retained logs from the managed stack identified by the current project, an optional `--stack`
name, or `--stack-id`. It calls the public `@supabase/stack` logs and followLogs APIs without
starting the stack, stopping it, or changing its owner lifecycle.

## Files read and written

The stack package reads its normal durable state under `<SUPABASE_HOME or ~/.supabase>` and
the selected stack's persisted log state. The CLI reads the current workdir and experimental
stack feature setting through its normal settings resolution. This command writes no project
files, stack state, credentials, or runtime resources.

## Output

Text mode writes `<timestamp> <service>/<stream>: <message>` followed by a newline for each
retained or followed entry. Terminal escape sequences and C0/C1 controls are removed from text
messages while tabs and newlines are preserved. JSON and bounded stream-json modes each write
one success/result payload containing `message`, `found`, and `entries`; when a stack is found,
it also contains `id`, `cursor`, and `running`. Log entry `message` values are preserved. `--follow` is
rejected with `--output-format json`; follow stream-json emits one `log-entry` event per entry.
Each event has `type: "log-entry"`, `timestamp`, `service`, `stream`, `line`, and `source`;
`line` preserves the original message, `stream` is `stdout`, `stderr`, or `internal`, and
`source` is `history` or `live`.

A found stack's bounded JSON result is shaped as follows (the entry message is raw):

```json
{
  "found": true,
  "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "entries": [
    {
      "cursor": { "opaque": "1" },
      "timestamp": "2026-09-08T00:00:00.000Z",
      "source": "database",
      "stream": "stdout",
      "message": "database ready"
    }
  ],
  "cursor": { "opaque": "1" },
  "running": false,
  "message": ""
}
```

With no default stack, JSON output is:

```json
{
  "found": false,
  "entries": [],
  "message": "No managed stack found for this context."
}
```

Follow prints the retained history first and then resumes from its returned cursor. If the stack
is already stopped, it prints the retained history and exits successfully. With no `--stack` or
`--stack-id`, an absent default stack prints a successful empty result. In stream-json mode this
is the standard result envelope:

```json
{
  "type": "result",
  "data": {
    "found": false,
    "entries": [],
    "message": "No managed stack found for this context."
  },
  "timestamp": "..."
}
```

A finite stream-json read emits one result event for a found stack, including when its entries
are empty. Follow mode emits only `log-entry` events; a found stack with no retained entries
emits no follow events, and a stopped stack exits successfully. A missing named stack fails with
status `1`. The legacy `-o`/`--output` flag is rejected; use
`--output-format`.

`--service` accepts one registered service instance ID and excludes supervisor and gateway entries, including
their startup diagnostics. Omit it to include all sources. Retained logs are bounded to the
newest 1000 entries or 1 MiB, whichever is reached first; `--tail` further limits the returned
entries.

Successful reads, including an absent default stack and a stopped stack, exit with status `0`.
Invalid flags, missing named stacks, and stack read failures exit with status `1`. Interrupting
follow cancels the log reader, exits with status `130`, and leaves the managed stack owner
untouched.

## Telemetry

On normal command completion, the command wrapper fires the standard `cli_command_executed` event
with the command name, exit code, duration, and safe flag metadata. An interrupted follow may
terminate before that event is captured. Stack log contents and messages are not sent as custom
telemetry properties. Telemetry state is flushed to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json` after both successful and failed command runs.
