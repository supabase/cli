# `supabase stack logs`

Streams live stdout/stderr from the selected saved stack. The experimental
feature flag controls command registration. It connects to an existing owner;
it never launches an owner or starts/stops a service.

## Selection and files

Select the current project/branch/name, `--stack <name>`, or `--stack-id <id>`.
The selectors are mutually exclusive. By default, only composition members are
included. `--service <kind-or-instance-id>` can also select standalone instances.
An unavailable owner, missing stack, or unmatched service fails with status 1.

Reads saved definitions under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/`.
Discovery ensures the registry directory exists with mode 0700 and probes local
owners. Shared routing/settings may read project config and profiles. No project
files, service configuration, artifacts, or data are changed.

## Output and cancellation

This is a live-only stream with no retained history, cursor, or `--tail` option.
It continues until interrupted or the selected streams close. `--follow` is
unnecessary and is not accepted. Legacy `-o/--output` and finite JSON output are
rejected; use text or `--output-format stream-json`.

Text writes `<timestamp> <service>/<instance-id>/<stream>: <line>`. Terminal
control sequences are stripped from text. Stream JSON emits `log-entry` events
with `timestamp`, `service`, `instance_id`, `stream`, `line`, and `source: "live"`.
Lines preserve their content in machine output. UTF-8 and line fragments are
assembled separately for each instance and stdout/stderr channel. Timestamps
reflect receipt by the CLI. Delivery is best effort: slow subscribers can lose entries. Ordering across
stdout/stderr channels and different services is not guaranteed.

Interrupting the command cancels its subscriptions, exits with status 130, and
leaves the owner and services running. Successful stream completion exits 0;
selection, connection, or stream failures exit 1.

## Telemetry

Standard command telemetry is retained; log contents are not custom telemetry
properties. Telemetry flushes on every exit to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
