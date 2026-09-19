# `supabase stack list`

Lists persisted local stacks when `experimental.stack` is enabled. Discovery probes
existing owners but never launches an owner or starts, stops, or prepares services.
The handler does not load project configuration.

## Files and network

Reads `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/state.json` and probes existing
local owner control endpoints. It makes no hosted API calls. Shared command setup
may read project configuration for the feature gate and the selected profile for
CLI settings. Discovery creates the registry directory if absent and sets its mode to 0700;
no stack state files are written. Telemetry flushes to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json` on success and failure.

## Output

Entries contain `id`, `project_root`, `name`, `branch_context`, `runtime` (native,
docker, or podman), and `owner` (reachable or unavailable). Owner availability is
not service lifecycle or health. Entries sort by project root, name, then ID.
Text shows NAME, PROJECT, BRANCH, RUNTIME, OWNER, and a compact ID. An empty
registry prints `No managed stacks found.` Use `--output-format json` to obtain
the full ID required by `--stack-id`; the text column shows only a prefix.

JSON emits `{ "stacks": [...], "message": "" }`; stream-json wraps that data in
one result event. A corrupt state document fails the entire discovery operation;
no partial list or invented per-entry metadata is emitted.

## Flags and exit codes

Explicit legacy `-o/--output` is rejected; use `--output-format text`, `json`, or
`stream-json`. Exit status is 0 on successful discovery, including an empty
registry or unavailable owners; 1 on invalid flags, registry failure, or shared
configuration failure; 130 on interruption.

## Telemetry

The existing command wrapper emits `cli_command_executed` subject to consent.
No custom events are emitted and stack identities are not telemetry properties.
