# Shadow database provisioning

How `db diff` / `db pull` / `db schema declarative sync` provision the shadow Postgres they diff
against, and why it is shaped the way it is. As-built notes, not a plan.

## Why the shadow is on every hot path

These commands hand pg-delta an **isolated shadow** (`pgdelta … --isolated-shadow`, loader mode
`isolatedCluster`): a `supabase/postgres` container brought to the platform baseline — the bundled
init schema plus the PG15+ one-shot realtime / storage / auth migrate jobs — before the user's own
migrations are applied. pg-delta requires that shadow on a different Postgres lineage than the
target, so the container is on the hot path of _every_ plan; the migrations-catalog cache cannot
make it go away.

Owner: `src/legacy/shared/db-bootstrap/shadow-database.ts` (the primitives) and
`shadow-cache.ts` (the acquire/release seam every call site actually uses,
`legacyWithShadowDatabase`).

## Readiness: a connect probe, not Docker health

`legacyWaitForShadowReady` (`health-check.ts`) polls, on a 1s constant backoff:

1. `docker inspect` — is the container still `running`? (preserves the crash detection the health
   gate gave us: a dead container fails fast instead of at the end of the budget); then
2. a short-timeout Postgres connect — success ⇒ ready.

The shadow's own healthcheck is `interval=10s` with no `start_period`/`start_interval`
(`postgres.service.ts`, deliberately unchanged — other tooling reads that config), so Docker's
first probe runs at t+10s while Postgres has been accepting connections since ~3.5s. Gating on
`Health.Status` spent ~6.5s per provision waiting for an already-knowable verdict.
`--health-start-interval` would fix the container side but needs Docker Engine 25+/API 1.44 and is
not reliably supported by Podman (which `spawnContainerCli` falls back to), so the CLI-side wait
asks Postgres directly instead. The failure shape is identical to the health gate's — same
`LegacyHealthCheckTimeoutError`, same `docker logs` dump.

## Fast shutdown: the entrypoint `exec`s Postgres

All three entrypoint builders in `postgres.service.ts` (`…Pg15` / `…Pg14` / `…Restore`) `exec` the
final `docker-entrypoint.sh` command, so PID 1 is Postgres and receives SIGTERM directly. With `sh`
as PID 1 the signal was swallowed and every `docker stop` burned the full 10s grace period before
a SIGKILL. This benefits `supabase stop` too, and it is what makes the cache's own mid-run stop
cheap. The divergence from Go's script is documented at the builders.

## The PGDATA snapshot cache

`SUPABASE_SHADOW_CACHE` — **on by default**; set it to `false` or `0` to opt out, in which case
the acquire is exactly `legacyCreateShadowDatabase` and the release exactly
`legacyRemoveShadowDatabase`.

Everything above the user's migrations is deterministic in the config, so it is cached as a
disk-level snapshot of the initialized data directory:

- **Cold** (no snapshot for this key): create the shadow and run the baseline as usual, then — at
  the baseline/migrations seam, before `contrib_regression` or any user migration —
  `docker stop`, stream `docker cp <id>:/var/lib/postgresql/data -` to
  `supabase/.temp/pgdelta/shadow-baseline-<key>.tar`, `docker start`, re-await readiness, continue.
- **Warm** (that tar exists): create the shadow, unpack the tar into the created-but-not-yet-started
  container (`docker cp - <id>:/var/lib/postgresql`), then start it. `docker-entrypoint.sh` finds a
  `PG_VERSION` file and skips `initdb` and the whole baseline; the caller is told
  `baselinePresent: true` (`LegacyShadowBaselineState`, `shadow-database.ts`) and goes straight to
  `contrib_regression` + user migrations.

### Cache key

sha256 (16 hex chars, fixed field order) over every input baked into the cluster during a cold
provision — `legacyShadowCacheKey`:

- resolved `supabase/postgres` image tag (full tag, _not_ major version) after registry/pin
  resolution;
- resolved one-shot job image tags (`realtime`, `storage`, `auth` via `legacyResolvePinnedImage` +
  `serviceVersionOverrides`), each included **only when its service is enabled** — a disabled
  service's job never ran into the baseline;
- the service enabled flags themselves;
- `jwtSecret`, `rootKey`, `[db] password`, `db.settings` (canonical JSON), `jwtExpiry`;
- effective `api.auto_expose_new_tables` (tri-state: unset ≠ explicit `false`);
- `supabase/roles.sql` contents (empty string when absent);
- `[db.vault]` secret **names and values** — both land in `vault.secrets`. (`setupInputsToken` in
  `legacy-pgdelta.cache.ts` hashes names only and omits the job image tags; it is a Go-parity
  contract and is deliberately not reused here, only its hashing style is.)
- `shadowPort` and `db.major_version`;
- the resolved JWKS string that realtime's one-shot tenant-seed job bakes in, included **only when
  realtime is enabled AND `major_version >= 15`** — the exact compound gate that decides whether
  the job is ever reached. An `auth.third_party` change moves this value and nothing else.

### Invariants

- **Atomic publish.** The tar is streamed to `<name>.<pid>.partial` and `rename`d into place, so a
  partial tar is never observable under the final name and a reader holding the old inode keeps a
  valid fd across a rename-over.
- **No lock file, no coordination.** Every run creates its own container, so no two runs can
  contend for one cluster. Two concurrent cold writers on the same key both export and the last
  `rename` wins — both tars are equally valid, since the key covers every baked-in input.
- **Retention: current key only.** Publishing a key's tar removes every other
  `shadow-baseline-*.tar` in the directory (a snapshot is ~90MB with default services, so a project
  holds one, not one per config permutation it has ever used).
- **Escape hatch.** Any warm-path failure (the `docker cp` in, the start, the readiness wait)
  removes the container, **deletes the tar** as suspect, and cold-provisions. Any cold-path export
  failure warns on stderr and leaves the run uncached; the container is restarted either way. The
  cache never fails a user's command and never hands back a wrong baseline — worst case is the
  uncached behavior.
- **No container outlives a run.** Cold, warm, and cache-disabled shadows all carry the same two
  project labels and are removed with `docker rm -f -v` on release. There is no cache-key Docker
  label and nothing extra for `supabase stop` to sweep.
- **One forced divergence:** the cold path drops `--rm`, because Docker destroys an `AutoRemove`
  container the moment it exits — `docker stop` included (verified on Docker 29: gone ~1-2s after
  the stop returns) — which would leave nothing to restart. The container is still removed on
  release; the only visible consequence is that a SIGKILLed CLI leaves a stopped, project-labeled
  shadow behind instead of nothing.

### Why a plain file

The artifact is a tar under the project's own temp directory, not a Docker object. Nothing about
the mechanism is container-specific, so a future **native** (non-Docker) Postgres service can reuse
the same snapshot by unpacking it into its own data directory — which is why the export is a file
rather than a `docker commit` image or a kept container.

## Measured

Benchmarked on `public.ecr.aws/supabase/postgres:17.6.1.158`, Docker 29, warm image cache:

| Phase                                                          | Time                          |
| -------------------------------------------------------------- | ----------------------------- |
| `docker create` + secret `docker cp` + `docker start`          | ~0.4s                         |
| Postgres accepting connections (initdb + bundled init SQL)     | ~8-11s                        |
| One-shot realtime job (Elixir boot + tenant seed)              | ~6.5s                         |
| One-shot storage migrate job                                   | ~2.5s                         |
| One-shot auth (`gotrue migrate`) job                           | ~0.7s                         |
| **Cold provision total** (excl. image pulls, excl. migrations) | **~30s wall**                 |
| Snapshot export (`docker cp … -` to file)                      | ~0.65s (39MB bare cluster)    |
| Snapshot restore (`docker cp - …`, before start)               | ~0.6s                         |
| Restored container `docker start` → connectable                | ~2s (initdb skipped entirely) |

Docker's healthcheck reported `healthy` at ~10.2s on the same container, which is the ~6.5s of dead
wait the connect probe removed.

## Known gaps

- `db diff --use-pgadmin` and `migration squash` provision the same shadow but keep the
  Docker-health gate and do not go through `legacyWithShadowDatabase`, so they are always cold.
- `db pull --declarative`'s bare shadow (`legacyPrepareRawShadow`) runs no platform baseline, so
  there is nothing for this cache to snapshot; it stays cold by construction.
- The snapshot is taken **before** user migrations on purpose (that is what makes it reusable
  across migration edits). Snapshotting the post-migration state as well, keyed on a migrations
  hash, is the obvious next step for repos with large migration histories.
