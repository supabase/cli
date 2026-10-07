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
directory was deleted, destroy selects them; when none do, the id is not found as
usual, and the error detail names an engine that failed to list its containers.
After the same confirmation (`the containers deleted stack <id> left behind`) it
removes them and prints `Removed the containers stack <id> left behind.`, or,
when the other engine failed to list its containers, fails naming that engine
after removing them; a deleted directory took the stack's lease with it, so this
includes the containers of an owner that still runs. When another process holds
the stack's lease, destroy fails and asks to run it again; when the stack is
registered again before an engine's cleanup starts, destroy fails and leaves
that engine's containers to the new registration; a registration that lands
later is not noticed, which is harmless because it cannot own containers while a
cleanup holds the lease. The deleted stack's data in the state root's shared
database volume stays, and containers of other state roots are never touched;
for a deleted `SUPABASE_HOME`, run destroy with that `SUPABASE_HOME`.

After confirmation the command opens the selected handle and destroys its entire
namespace. Destruction may start an owner to clean up a stopped namespace.
Cleanup failures remain errors; the command does not claim success on failure.
Shutdown is one-way: a failed destroy leaves the stack registered and its
owner exits; the next command retries.

As with `stack stop`, services stop in reverse dependency order with every
stack listener still open, and traffic that would wake a stopped service during
shutdown is refused.

When no owner is running and the engine reports that its daemon cannot be
reached, destruction removes nothing: the registration, port claims and host
data stay as they are, and the command exits 1 with one error whose suggestion
gives the exact `supabase stack destroy --stack-id <id> --yes` command to run
once the engine is reachable. Any other engine failure, an owner starting during
destruction, an instance whose data (including a native database's socket
directory) cannot be removed, or a labelled container that survives removal,
fails the command and keeps the stack registered; the error lists what
remains. A native runtime root that is not trusted (a symlink, owned by another
user or writable by others) is warned about and its socket directories are left
in place.

## Files and network

Reads identity/state under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/` and, for
implicit selection, the project's canonical Git context. Removes only the
selected namespace's owned state/data; other stack namespaces and caller-owned
uploads are preserved. The independent artifact cache is retained. Communicates
with the local owner and selected runtime, with no hosted API calls. Shared
routing/settings can read project configuration and profiles.

Destruction releases this stack's rows in the per-user port registry at
`<passwd home>/.supabase/ports.sqlite` (independent of `SUPABASE_HOME`, with no
override) only once cleanup is confirmed complete; a destroy that fails
keeps the stack's reservations, and its ports remain unavailable
to other stacks until a later destroy succeeds. A reservation whose owning
stack's state was deleted without going through destroy (for example a removed
or unmounted state root) is released lazily by whichever stack next needs that
port. That stack's still-running owner notices the lost registration within its
next check (30 seconds by default), stops its workloads and exits without
deleting data or releasing reservations.

## Output, exit codes and telemetry

Text prints `Stack <id> destroyed.` (`Removed the containers stack <id> left behind.`
for a deleted stack's containers). JSON and stream-json success data contain
`destroyed` (`true`) and `id`. Exit 0 on destruction, 1 on invalid flags, missing
selection, rejected/cancelled confirmation, an unreachable engine, or cleanup
failure, and 130 on interruption. A saved stack whose state cannot be decoded
(for example one saved by an older CLI with a service kind this CLI no longer
knows) fails with an error naming its directory under the state root; removing
that directory discards the stack. Its leftover containers are then removed
when a container stack next starts under the same state root or by
`destroy --stack-id`, and its port reservations are released when another stack
needs them; its data in the shared database volume is not removed. Standard command telemetry is unchanged, with no custom events.
Telemetry flushes on success and failure to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
