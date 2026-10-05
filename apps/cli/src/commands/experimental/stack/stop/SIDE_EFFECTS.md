# `supabase stack stop`

Stops the selected managed stack's entire namespace, including standalone
services and attached jobs. Definitions, data, and assigned ports remain saved.
The experimental top-level `supabase stop` alias delegates to this handler.

## Selection and output

Select the current project/branch/name, `--stack <name>`, or `--stack-id <id>`.
`--stack` and `--stack-id` are mutually exclusive. `--all` cannot be combined
with either selector. Explicit legacy `-o/--output` is rejected; use
`--output-format` instead.

Discovery probes saved owners before shutdown. If no owner is reachable, the
command does not start one; it reclaims the stack's leftover workloads under the
stack lease and reports `Stack <id> was not running; leftover resources were reclaimed.`
It fails when another process holds the lease or the cleanup fails, so a stack
whose owner exited after a failed stop can be stopped again. If an owner
disappears after discovery, the shutdown error remains a failure.

Before any service stops, the owner stops accepting new connections on every
stack listener and lets connections already established keep flowing for up to
10 seconds, then cuts whatever remains. A request in flight when `stop` is
issued can still complete, at the cost of the command waiting up to that long
longer for shutdown to finish.

Text confirms each successful shutdown and identifies each stack that had no owner.
JSON and stream-json success data contain `stopped` and `notRunning` ID arrays.
A missing default selection reports `found: false`; an unknown explicit name or
ID fails. A single selection reads only the selected stack's state document; an
unreadable document fails the selection instead of being reported as missing.
`--all` attempts every selected stack and reports failures with their
IDs. It skips state entries that cannot be read or decoded with a warning on
stderr identifying each stack; only a failure to read the stacks directory
itself fails discovery.

## Files and network

Reads saved state under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/` and the
current project/Git identity when no explicit ID is supplied. Shared routing and
settings may read project configuration and the selected profile. Communicates
only with local owner endpoints; no hosted API requests. Shutdown updates owned
runtime resources but preserves persistent instance definitions, data and port
reservations in the per-user registry at `<passwd home>/.supabase/ports.sqlite`
(unaffected by `SUPABASE_HOME`); killing the owner process preserves them the
same way. No caller-owned upload files are removed.

## Exit codes and telemetry

Exit 0 on successful shutdown or reclaim, or absent default selection;
1 for invalid flags, selection/registry failure, or shutdown or reclaim failure; 130 on
interruption. The command wrapper retains standard command telemetry, with no
custom events. Telemetry flushes on success and failure to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
