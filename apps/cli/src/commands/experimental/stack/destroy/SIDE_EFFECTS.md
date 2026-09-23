# `supabase stack destroy`

Permanently removes the selected managed namespace, its service registrations,
owned database data, port claims, and attached jobs. Caller-owned Storage upload
files remain. The experimental feature flag controls command registration.

## Selection and confirmation

Select the current project/branch/name, `--stack <name>`, or `--stack-id <id>`.
The selectors are mutually exclusive; a missing target fails. Explicit legacy
`-o/--output` is rejected in favor of `--output-format`.

Interactive text mode asks for confirmation and states that Storage uploads are
preserved. Non-interactive and machine-output runs require `--yes`. Rejection or
cancellation does not open or destroy a stack. Discovery may create/chmod the
registry directory to 0700 but does not launch an owner.

After confirmation the command opens the selected handle and destroys its entire
namespace. Destruction may start an owner to clean up a stopped namespace.
Cleanup failures remain errors; the command does not claim success on failure.
A failed destroy may leave its owner running; retry destruction or use
`stack stop` to shut down that owner.

## Files and network

Reads identity/state under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/` and, for
implicit selection, the project's canonical Git context. Removes only the
selected namespace's owned state/data; other stack namespaces and caller-owned
uploads are preserved. The independent artifact cache is retained. Communicates
with the local owner and selected runtime, with no hosted API calls. Shared
routing/settings can read project configuration and profiles.

## Output, exit codes and telemetry

Text prints `Stack <id> destroyed.`; JSON and stream-json success data contain
`destroyed: true` and `id`. Exit 0 on destruction, 1 on invalid flags, missing
selection, rejected/cancelled confirmation or cleanup failure, and 130 on
interruption. Standard command telemetry is unchanged, with no custom events.
Telemetry flushes on success and failure to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
