# `supabase stack update [service...]`

The command is available when the experimental stack family is enabled. It re-resolves the named
services of `supabase/supabase.lock`, or every service when none is named, and writes the lock. It
creates, starts and registers no stack, downloads no artifact, and reads no stack state or database
data, so it needs no stack selector.

## Service versions and the lock

The lock is read and written as `supabase stack start` does it (see "Service versions and the lock"
in [`../start/SIDE_EFFECTS.md`](../start/SIDE_EFFECTS.md)), under the same project lease
`supabase/.supabase.lock.lease`. Each named service is resolved again even when its entry is fresh:

- `<upstream>` (a version without a revision) moves to the newest published revision.
- `<upstream>-r<N>` names one exact release and keeps its pin.
- `bundled` moves to the version bundled with this CLI.
- `linked` probes the hosted project or branch named by `supabase/.link.json` again (the
  `update.probe` span) and resolves to the version it reports, retrying a service that fell back as
  `unobserved` or `unpublished`. Entries that follow another specifier take the new observation in
  their `linked` field. When the target differs from the remote the lock observed, every `linked`
  entry is resolved again against the new target and nothing from the old remote is kept. A probe
  that fails transiently keeps the previous entry only when nothing it depends on changed, else
  takes the bundled version as `unobserved`, with a warning. Without `supabase/.link.json`, or
  when no `linked` entry is re-resolved, no probe runs and the stored observations apply; an
  unlinked project resolves `linked` to the bundled version as `unlinked`.
- A named service whose specifier changed since the lock was written is resolved again. A stale
  service that was not named keeps its entry; the command reports it as skipped and leaves it for
  `supabase start` or `supabase stack update <service>`.
- A missing lock is resolved in full.

Services that are not named keep their entries byte for byte. The lock is written, and
`supabase/.gitignore` gains the lease and staged-write entries, only when an entry changed. The
lease file is created on every run, including one that changes nothing. When nothing changed and no
stale service was skipped, the command reports `supabase/supabase.lock is already up to date.`.

`update` takes no `--frozen`, and `CI` does not freeze it: running it is the request to rewrite
the lock. A project without `supabase/config.toml` fails with reason `invalid-config`. A service
name that is not one of the twelve services fails with reason `flags` and lists the valid names;
nothing is resolved or written.

## Files read

- `<workdir>/supabase/config.toml`, project dotenv files, supported `SUPABASE_*` overrides,
  `<workdir>/supabase/supabase.lock`, and `<workdir>/supabase/.link.json`.
- Shared profile and telemetry state under `<SUPABASE_HOME or ~/.supabase>/`.

## Files written

- `<workdir>/supabase/supabase.lock` (JSON), only when an entry changed.
- `<workdir>/supabase/.supabase.lock.lease` on every run, and `.supabase.lock.*.tmp` while the lock
  is written; `supabase/.gitignore` gains both entries only when the lock is written.
- Telemetry state after success or failure.

## Network and subprocesses

Resolving a release specifier probes the slim-services GitHub releases and registry
(`SUPABASE_INTERNAL_SLIM_RELEASES_URL` and `SUPABASE_INTERNAL_SLIM_REGISTRY_URL` redirect them).
Only the named services of the `<upstream>` or `linked` form are probed there.

Only when a named service has the `linked` specifier and `supabase/.link.json` exists does the
command also need a login (the same as `supabase link`; `start` never does) and call the Management
API (`getProject`, or `getABranchConfig` for a branch; `getProjectApiKeys` with `reveal`) and the
target's tenant host (`/rest/v1/`, `/auth/v1/health`, `/storage/v1/version`, with the service-role
key, which is never logged). A missing login, or a failed Management API call, fails with reason
`hosted` and writes nothing. No archive or image is downloaded and no subprocess runs.

## Flags and output

Positional `service` names; the legacy `-o/--output` flag is rejected, use `--output-format`.

A change that moves only the resolution (for example `unobserved` to `resolved`) shows the
version with the new resolution in parentheses, and a `linked` entry's reason is `follows the
linked project`. Text output lists each changed service as `<service> <from> → <to>  (<reason>)`, a summary of
changed and unchanged entries, and one `<service> is stale (<reason>); run supabase start or
supabase stack update <service>` line per skipped stale service.

JSON output returns `lock` (`file`, `written`, `added`, `changed`, `unchanged`, `stale` as the
names of skipped stale services) and an empty
message. Errors retain typed actionability.

## Exit codes

- `0` when the lock was updated or left as it was, including when stale services were skipped.
- `130` when interrupted.
- `1` for a rejected output flag, an unknown service, invalid configuration, a lock that cannot be
  read, a failed resolution, or a failed hosted probe (reason `hosted`).

## Telemetry

The command emits the standard `cli_command_executed` event through command telemetry and flushes
telemetry state after success or failure. It emits no custom event.
