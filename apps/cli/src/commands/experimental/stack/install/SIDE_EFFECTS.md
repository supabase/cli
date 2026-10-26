# `supabase stack install`

The command is available when the experimental stack family is enabled. It resolves the project's
service versions into `supabase/supabase.lock` and downloads everything the lock pins for the chosen
runtime. It creates, starts and registers no stack, and reads no stack state or database data, so
it needs no stack selector.

## Service versions and the lock

The lock is read, resolved and written exactly as `supabase stack start` does it (see "Service
versions and the lock" in [`../start/SIDE_EFFECTS.md`](../start/SIDE_EFFECTS.md)), under the same
project lease `supabase/.supabase.lock.lease`:

- A lock that answers the current `[local.services]` request is used as-is, with no network.
- A missing lock, or a service whose specifier changed, is resolved again and the lock is written.
  The `Resolved service versions` report lists the diff.
- `--frozen`, or the `CI` environment variable (not empty, `false` or `0`) with an existing lock,
  fails instead of writing: a missing lock fails with `supabase/supabase.lock not found`, a stale one
  with `is stale for: <service> (<reason>)`. Nothing is downloaded after a lock failure. A frozen
  run reads the lock without the lease and writes nothing in the project.
- A `linked` service follows the hosted version `supabase link` recorded, resolved on the release
  host only; install never calls the Management API or needs a login. When the release host cannot
  be reached for it, the service takes the bundled version as `unobserved` and warns instead of
  failing; only an explicit `<upstream>` specifier fails with transient (`network`). A `.link.json`
  that targets another remote than the lock observed, or a newer bundled revision of a locked
  version, prints a warning (see `start`).
- A project without `supabase/config.toml` uses the versions bundled with the CLI and writes no lock.
  Frozen, by `--frozen` or by `CI` with an existing lock, the lock cannot be checked, so it fails
  with `supabase/config.toml not found` rather than using the bundled versions; `--frozen` without
  a lock fails with `supabase/supabase.lock not found`. Both fail before anything is downloaded.
  Without a lock `CI` changes nothing.

To move a fresh entry to a newer release, use `supabase stack update`; `supabase stack outdated`
reports which entries would move (see [`../update/SIDE_EFFECTS.md`](../update/SIDE_EFFECTS.md) and
[`../outdated/SIDE_EFFECTS.md`](../outdated/SIDE_EFFECTS.md)).

## Download

`--runtime` defaults to `auto`, which selects Docker, then Podman, then native, as `stack start`
does for a new stack; an explicit value has no fallback. Explicit `--runtime native` on a platform
with no native artifacts fails with reason `flags`. Reason `runtime` applies only to `auto` when no
engine is found; an explicit `docker` or `podman` with an unreachable engine fails with reason `stack`
(kind `engine-unavailable`).

- `native` downloads the locked archive of each of the twelve services for the current platform
  into `$SUPABASE_HOME/cache/stack` (`~/.supabase/cache/stack` by default), verifying the pinned
  archive and manifest digests. An artifact already in the cache is not downloaded again.
- `docker` and `podman` pull each locked image by digest through the selected engine; an image the
  engine already holds is not pulled again.

Up to four services are fetched at a time. A download failure fails the command with reason `stack`
and keeps the package's failure kind; archives that completed stay cached.

## Files read

- `<workdir>/supabase/config.toml`, project dotenv files, supported `SUPABASE_*` overrides, and
  `<workdir>/supabase/supabase.lock`.
- Shared profile and telemetry state under `<SUPABASE_HOME or ~/.supabase>/`.

## Files written

- `<workdir>/supabase/supabase.lock` (JSON), only when it is missing or stale and not frozen.
- `<workdir>/supabase/.supabase.lock.lease` and `.supabase.lock.*.tmp` while the lock is written;
  `supabase/.gitignore` gains both entries whenever the project lease is taken. A frozen run takes
  no lease and writes neither.
- Native archives under `$SUPABASE_HOME/cache/stack`, keyed by content digest.
- Container images in the selected engine's image store.
- Telemetry state after success or failure.

## Network and subprocesses

Resolving a release specifier probes the slim-services GitHub releases and registry
(`SUPABASE_INTERNAL_SLIM_RELEASES_URL` and `SUPABASE_INTERNAL_SLIM_REGISTRY_URL` redirect them). Native
downloads fetch from the release host, falling back to a public S3 mirror. Container runtimes run
the engine's CLI to inspect and pull images. No service process is started.

## Flags and output

`--runtime auto|docker|podman|native` and `--frozen`. The legacy `-o/--output` flag is rejected;
use `--output-format`.

Text output prints the lock diff when it changed, then whether `supabase/supabase.lock` was written
or is up to date, a `Downloaded N of M archives|images for the <runtime> runtime; K already present.`
summary, and one `<service> <release> (downloaded|cached)` line per service.

JSON output returns `runtime`, `lock` (`file`, `written`, `added`, `changed`, `unchanged`; `null`
without a project config), `artifacts` (`service`, `release`, `outcome`), `downloaded` and `cached`,
and an empty message. Errors retain typed actionability and package diagnostics.

## Exit codes

- `0` when the lock is current and every artifact is present.
- `130` when interrupted.
- `1` for a rejected output flag, invalid configuration, a stale or missing lock under `--frozen`, a
  failed resolution, an unavailable runtime, or a failed download.

## Telemetry

The command emits the standard `cli_command_executed` event through command telemetry and flushes
telemetry state after success or failure. It emits no custom event.
