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
command reports `No owner is reachable; workload state is unavailable.` It
neither starts an owner nor claims workloads have stopped. If an owner disappears
after that preflight, the shutdown error remains a failure.

Text confirms each successful shutdown and identifies each unavailable owner.
JSON and stream-json success data contain `stopped` and `unavailable` ID arrays.
A missing default selection reports `found: false`; an unknown explicit name or
ID fails. `--all` attempts every selected reachable owner and reports failures
with their IDs. Corrupt registry state fails discovery without partial results.

## Files and network

Reads saved state under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/` and the
current project/Git identity when no explicit ID is supplied. Shared routing and
settings may read project configuration and the selected profile. Communicates
only with local owner endpoints; no hosted API requests. Shutdown updates owned
runtime resources but preserves persistent instance definitions, data and port
claims. No caller-owned upload files are removed.

## Exit codes and telemetry

Exit 0 on successful shutdown, absent default selection, or unavailable owner;
1 for invalid flags, selection/registry failure, or shutdown failure; 130 on
interruption. The command wrapper retains standard command telemetry, with no
custom events. Telemetry flushes on success and failure to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
