# `supabase stack destroy`

Permanently removes the selected managed namespace, its service registrations,
owned database data, port claims, and attached jobs. Caller-owned Storage upload
files remain. The experimental feature flag controls command registration.

## Selection and confirmation

Select the current project/branch/name, `--stack <name>`, or `--stack-id <id or unique prefix>`.
The selectors are mutually exclusive; a missing target fails. Explicit legacy
`-o/--output` is rejected in favor of `--output-format`.

Interactive text mode asks for confirmation and states that Storage uploads are
preserved. Non-interactive and machine-output runs require `--yes`. With `--yes`
the command prints no question; stderr states which stack and data are destroyed
and that Storage uploads are preserved. Rejection or cancellation does not open or
destroy a stack. Discovery may create/chmod the registry directory to 0700 but
does not launch an owner.

A full `--stack-id` that is not registered under the state root makes destroy
list stack-labelled containers on Docker and Podman before confirming; an engine
that is not installed or not running is skipped. When containers labelled with
that id and its data root there remain on either engine, for example because its
directory was deleted, destroy selects them; when none do and an engine failed to
list its containers, the command fails naming that engine. After the same
confirmation (`the containers deleted stack <id> left behind`) it removes them and
prints the usual success; a deleted directory took the stack's lease with it, so
this includes the containers of an owner that still runs. When another process
holds the stack's lease, destroy fails and asks to run it again; when the stack is
registered again meanwhile, destroy fails and leaves the remaining containers to
that registration. Its data in the state root's shared database volume stays, and
containers of other state roots are never touched; for a deleted `SUPABASE_HOME`,
run destroy with that `SUPABASE_HOME`.

After confirmation the command opens the selected handle and destroys its entire
namespace. Destruction may start an owner to clean up a stopped namespace.
Cleanup failures remain errors; the command does not claim success on failure.
A failed destroy may leave its owner running; retry destruction or use
`stack stop` to shut down that owner.

When no owner is running and the engine reports that its daemon cannot be
reached, destruction removes the local namespace and host data anyway, warns on
stderr that the stack's engine resources were not removed, and exits 0. The
warning lists the commands that remove them once the engine is running: one for
the stack's containers, and one per database whose data is kept in an engine
volume. Any other engine failure, an owner starting during destruction, or
host data the current user cannot delete (such as database files a container
wrote as its own user), fails the command before anything is removed and keeps
the stack registered; the last case asks to start the engine and retry.

## Files and network

Reads identity/state under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/` and, for
implicit selection, the project's canonical Git context. Removes only the
selected namespace's owned state/data; other stack namespaces and caller-owned
uploads are preserved. The independent artifact cache is retained. Communicates
with the local owner and selected runtime, with no hosted API calls. Shared
routing/settings can read project configuration and profiles.

## Output, exit codes and telemetry

Text prints `Stack <id> destroyed.`, or, when engine cleanup was skipped,
`Stack <id> was removed locally; its <Engine> resources remain until the commands above are run.`
JSON and stream-json success data contain `destroyed: true`, `id`, and
`runtimeCleanup` (`complete` or `skipped`); a skipped cleanup also carries `engine` and
`cleanupCommands`. Exit 0 on destruction, 1 on invalid flags, missing
selection, rejected/cancelled confirmation or cleanup failure, and 130 on
interruption. Standard command telemetry is unchanged, with no custom events.
Telemetry flushes on success and failure to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
