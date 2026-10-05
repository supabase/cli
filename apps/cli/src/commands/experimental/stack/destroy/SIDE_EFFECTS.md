# `supabase stack destroy`

Permanently removes the selected managed namespace, its service registrations,
owned database data, port claims, and attached jobs. Caller-owned Storage upload
files remain. The experimental feature flag controls command registration.

## Selection and confirmation

Select the current project/branch/name, `--stack <name>`, or `--stack-id <id>`.
The selectors are mutually exclusive; a missing target fails. Explicit legacy
`-o/--output` is rejected in favor of `--output-format`.

Interactive text mode asks for confirmation and states that Storage uploads are
preserved. Non-interactive and machine-output runs require `--yes`. With `--yes`
the command prints no question; stderr states which stack and data are destroyed
and that Storage uploads are preserved. Rejection or cancellation does not open or
destroy a stack. Discovery may create/chmod the registry directory to 0700 but
does not launch an owner.

After confirmation the command opens the selected handle and destroys its entire
namespace. Destruction may start an owner to clean up a stopped namespace.
Cleanup failures remain errors; the command does not claim success on failure.
A failed destroy may leave its owner running; retry destruction or use
`stack stop` to shut down that owner.

As with `stack stop`, the owner drains live connections on every stack listener
(up to 10 seconds) before any service stops, so a request in flight when
destroy is issued can still complete.

When no owner is running and the engine reports that its daemon cannot be
reached, destruction removes nothing: the registration, port claims and host
data stay as they are, stderr warns that Docker resources were not removed, and
the command exits 0 reporting the stack as not destroyed. Run destroy again once
Docker is reachable. Any other engine failure, an owner starting during
destruction, or resource claims the owner cannot reconcile (for example a
container on a different daemon) fails the command and keeps the stack
registered; the error lists the remaining claims and the `claims.json` path.

## Files and network

Reads identity/state under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/` and, for
implicit selection, the project's canonical Git context. Removes only the
selected namespace's owned state/data; other stack namespaces and caller-owned
uploads are preserved. The independent artifact cache is retained. Communicates
with the local owner and selected runtime, with no hosted API calls. Shared
routing/settings can read project configuration and profiles.

Destruction releases this stack's rows in the per-user port registry at
`<passwd home>/.supabase/ports.sqlite` (independent of `SUPABASE_HOME`, with no
override) only once cleanup is confirmed complete; a destroy that fails or skips
engine cleanup keeps the stack's reservations, and its ports remain unavailable
to other stacks until a later destroy succeeds. A reservation whose owning
stack's state was deleted without going through destroy (for example a removed
or unmounted state root) is usually released by that stack's own still-running
owner within its next registration check (30 seconds by default), which also
stops its workloads; the lazy reclaim by whichever stack next needs that port
remains the backstop when no owner is left alive to do so.

## Output, exit codes and telemetry

Text prints `Stack <id> destroyed.`, or, when engine cleanup was skipped,
`Stack <id> could not be fully destroyed because Docker is unreachable; restore it and run "supabase stack destroy" again.`
JSON and stream-json success data contain `destroyed` (`false` when engine
cleanup was skipped), `id`, and `runtimeCleanup` (`complete` or `skipped`); a
skipped cleanup also carries `engine`. Exit 0 on destruction or skipped engine cleanup, 1 on invalid flags, missing
selection, rejected/cancelled confirmation or cleanup failure, and 130 on
interruption. Standard command telemetry is unchanged, with no custom events.
Telemetry flushes on success and failure to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
