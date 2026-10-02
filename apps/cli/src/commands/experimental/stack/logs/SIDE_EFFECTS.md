# `supabase stack logs`

Prints the retained service logs of the selected saved stack and exits; with
`-f/--follow` it then streams new lines until interrupted. The experimental
feature flag controls command registration. It never launches an owner or
starts/stops a service.

## Selection and files

Select the current project/branch/name, `--stack <name>`, or `--stack-id <id>`.
The selectors are mutually exclusive. By default, composition members are
included, plus `gateway` (the shared API port's request lines) once the stack has
claimed that port. `--service <kind-or-instance-id>` is repeatable and can also select
standalone instances or `gateway`; a value that matches no saved instance, or
`gateway` without the shared API port, fails with status 1.
A missing stack fails with status 1.

Reads saved definitions under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/` and
the persisted segments under
`<SUPABASE_HOME or ~/.supabase>/stacks/<id>/logs/<service>/<instance-id>/<generation>.log`
directly, so history is readable while the owner is down. Discovery ensures the
registry directory exists with mode 0700 and probes local owners. Shared
routing/settings may read project config and profiles. No project files,
service configuration, artifacts, logs, or data are changed.

## History, follow, and flags

`--tail N` (default 200, 0 prints none) keeps the newest N output lines across
the selected services, with the `launch` and `lost` markers between them.
`--since` accepts a duration before now (`30s`, `10m`, `1h30m`, `2d`), an
ISO-8601 time, or `start`, which keeps the records of each instance's current
launch and later ones, in history and while following. The current launch is the
launch id saved in the stack definition, which keeps increasing across owner
restarts, or else the highest launch record in history (all records when
retention removed that launch record). Records are
ordered by timestamp, service, instance, and file position. Timestamps are the
owner's clock at each line's first byte. Lines end at `\n`, `\r\n`, or a lone
`\r`, so carriage-return progress updates print as separate lines. History is
read as a stream holding at most N lines per instance, while every matching line
is counted for the footer.

`-f/--follow` requires a reachable owner: without one it fails with status 1
before printing anything and suggests running without `--follow`. It prints the
history, then streams each instance's new records through the owner from the
last record read, so no record is repeated or skipped between history and live
output. With `--tail 0` no history is read and the owner starts each follow at
its current end. A selected instance the running owner does not serve is named
in a warning and not followed; when it serves none of them, the command fails
with status 1 after printing the history. The owner's log shipping to Analytics reads the persisted logs
separately and does not affect this command.

## Output

Text writes `<service> | <HH:MM:SS.mmm> <line>` with the service labels padded
to one width; a service kind selected more than once is labelled
`<service>:<first 8 characters of the instance id>`. Times are local. `launch`
and `lost` records are dim separator lines (`--- launch 2 ---`,
`--- 3 stdout chunks lost ---`, `--- older records were removed by retention ---`).
Labels are coloured and markers dimmed only when stdout is a colour-capable
terminal. Terminal control sequences are stripped from text. When a non-zero
tail hides older lines, stderr gets
`showing last 200 of 5,234 lines, use --tail/--since`; an empty history without
`--follow` prints `No retained log lines for the selected services.` on stderr.

Stream JSON emits a `log-entry` event per output line with `timestamp`,
`service`, `instance_id`, `stream` (`stdout` or `stderr`), `line`, and `source`
(`history` or `live`), and a `log-marker` event per marker with `timestamp`,
`service`, `instance_id`, `kind` (`launch` or `lost`), `source`, and, for chunks
lost before they were written, `stream` and `count`. A `lost` marker without
`count` reports segments removed by retention. `--output-format json` prints
one array of the same objects; it cannot be combined with `--follow`. Lines
preserve their content in machine output. Legacy `-o/--output` is rejected.

Interrupting a follow cancels its subscriptions, exits with status 130, and
leaves the owner and services running. History reads and completed follows exit
0; selection, owner, or read failures exit 1.

## Telemetry

Standard command telemetry is retained, with `-f` reported as `follow`; log
contents are not custom telemetry properties. Telemetry flushes on every exit to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
