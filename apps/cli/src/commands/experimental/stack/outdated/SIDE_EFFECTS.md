# `supabase stack outdated`

The command is available when the experimental stack family is enabled. It reports, for each of the
twelve services in `supabase/supabase.lock`, the locked release and the release
`supabase stack update` would lock. It changes nothing: it takes no lease, writes no file and
downloads no artifact.

## What it reports

Each row has the service, the specifier from the lock, the hosted version the lock last observed
(`-` when none), the locked release, the update (absent when
`stack update` would keep the entry), the release bundled with this CLI, and a status:

- `up to date`: `stack update` would keep the entry.
- `update available`: the specifier is `<upstream>` and a newer revision is published, or the
  specifier is `bundled` and this CLI bundles a different release, or the specifier is `linked` and
  its stored observation now resolves to a different release or resolution (for example a version
  slim-services has since published).
- `stale`: the entry no longer answers `config.toml`; the reason is listed under the table. It is
  not probed, because `supabase start` re-resolves it.
- `probe failed`: the newest release could not be determined, for example when the release host
  answered with a server error. The reason is listed under the table, and the command still
  succeeds.

An exact `<upstream>-r<N>` specifier is never probed. A missing lock, or one that cannot be read,
fails the command with reason `lock`; `invalid-config` is only for `config.toml` problems, such as a
project without `supabase/config.toml`.

## Files read

- `<workdir>/supabase/config.toml`, project dotenv files, supported `SUPABASE_*` overrides, and
  `<workdir>/supabase/supabase.lock`.
- Shared profile and telemetry state under `<SUPABASE_HOME or ~/.supabase>/`.

## Files written

- Telemetry state after success or failure. Nothing under `supabase/`.

## Network and subprocesses

Each `<upstream>` entry, and each `linked` entry with an observation, that is not stale is probed
against the slim-services GitHub releases and registry (`SUPABASE_INTERNAL_SLIM_RELEASES_URL` and
`SUPABASE_INTERNAL_SLIM_REGISTRY_URL` redirect them), up to four at a time. It never calls the
Management API or a tenant host and needs no login, so a hosted version that moved since
`supabase link` shows only after `supabase stack update`. No archive or image is downloaded and no
subprocess runs.

## Flags and output

The legacy `-o/--output` flag is rejected; use `--output-format`.

Text output prints the table, one line per stale or failed row, and a hint naming
`supabase stack update` or `supabase start` when either applies.

JSON output returns `file`, `services` (`service`, `specifier`, `resolution`, `hosted`, `locked`, `update`,
`bundled`, `stale`, `error`; `null` when absent), and the `updatable`, `stale` and `failed` counts.

## Exit codes

- `0` whenever the report was produced, including when updates are available or a row failed.
- `130` when interrupted.
- `1` for a rejected output flag, invalid configuration, or a missing or unreadable lock.

## Telemetry

The command emits the standard `cli_command_executed` event through command telemetry and flushes
telemetry state after success or failure. It emits no custom event.
