# 0025. Ephemeral Postgres for schema tooling

**Status**: proposed
**Date**: 2026-09-09

## Problem Statement

`db diff`, `db pull`, `db schema declarative`, and `migration squash` provision a throwaway
shadow Postgres, snapshot its platform baseline as a PGDATA tar, and compare it to a target.
That path today always uses the legacy Docker local database: compose container IDs, platform
SQL templates, and `db.shadow_port`.

The managed stack runtime (`@supabase/stack`) is a different Postgres: slim-artifact init plus
a fixed role/JWT/`_supabase` bootstrap, native host `PGDATA` or a named volume, and no extra
database API. `[experimental].stack` currently switches top-level `start`/`stop`. With the flag
on, schema commands still inspect `supabase_db_<projectId>` and shadow against the legacy
baseline, so `--local` diffs are wrong or impossible.

A second Postgres **instance** is required. `CREATE DATABASE` on the live cluster is not
equivalent: declarative sync needs two independent servers, and the cache is a full PGDATA
snapshot.

## Domain language

- **Schema init**: the one-shot that mutates Postgres for an enabled capability that already has
  a prepare/migrate process, without starting that capability’s long-running process. Not
  activation, and not the CLI overlay. The throwaway compile is `database` plus the requested
  one-shot names (live: auth, storage, realtime; analytics and pooler only when those one-shots
  run). It never includes studio, mail, or functions. CLI `--exclude` does not change this set.
- **Overlay**: CLI session SQL after schema init: webhooks (`pg_net`), API default grants, vault
  upsert, and `roles.sql`. The CLI helper that runs schema init then overlay is not a fourth
  concept.
- **Activation**: starting a capability’s long-running process and listeners. Not schema init.
- **Disabled capability**: exactly `{ enabled: false }`; the stack config schema rejects nested
  pins (`version`, `settings`) on a disabled capability. Disable is not absence: schema-init can
  turn a disabled cap back on, compiling it with default settings.
- **First create**: this start created the live project stack (`unconfigured` / no stack). Analog
  of Compose’s fresh volume: schema init, Overlay, and user migrate-and-seed run once here.
- **Existing cluster**: a live project stack this start did not create (already-running or
  start-from-existing-data). Analog of Compose’s existing volume: webhooks setup only.

_Avoid_: treating `{ enabled: false }` as an empty object; “initialized PGDATA” as a setup
predicate; using stack `unconfigured` to mean “user migrations have not run.”

## Decision

### (a) Public `EphemeralPostgres` on `@supabase/stack`

The package exposes a scoped, Supervisor-free Postgres cluster API (`createEphemeralPostgres`)
on both the Effect and Promise facades. It is not a stack identity: it does not appear in
`listStacks` / `discoverStacks`, and it does not persist `state.json` under the managed stacks
root.

The cluster uses the same catalog artifact/image and the same bootstrap as a real stack
database. Callers own migrations, `roles.sql`, declarative SQL, and cache keys.

Handle operations: loopback URL; `stop` (process/container down, data retained); `start` (from
existing data); `exportPgData` only while stopped; destroy on scope close.

### (b) Snapshots are runtime-kind specific

Native Postgres runs as the host user. Container snapshots preserve image uids. A Docker tar must
not restore onto native, and the reverse is also refused. The cache key includes `runtime.kind`
(and engine). Native export is a host-tree tar of `PGDATA`; container export tars the volume
through the catalog Postgres image.

### (c) `[experimental].stack` covers the db/migration family

`SUPABASE_EXPERIMENTAL_STACK` / `[experimental].stack` select the stack backend for `db`,
`migration`, `test`, `gen`, `inspect`, and top-level `pull` as well as `start`/`stop`/`status`.
Flag off keeps the legacy Docker shadow and `supabase_db_*` local target. Linked /
`--db-url` targets stay URL/linked connections for engine and runtime selection
(`connType`); they do not switch the local engine. A `--db-url` whose host and port
match `config.toml` is still `isLocal` for dump's tool-container host rewrite. Top-level
`status` **is** aliased (`STACK_BACKEND_COMMANDS`).

Shadow baseline for the stack backend is slim-init, stack bootstrap, schema init for the
platform trio (auth, storage, realtime), and the CLI overlay. Cache files use a distinct
`stack-shadow-baseline-*` namespace. Analytics and pooler stay off the shadow baseline. Schema
init never compiles studio, mail, or functions (those are not Postgres catalog one-shots).

The stack backend requires the in-process pg-delta engine. Migra, pgAdmin, and
`--use-pg-schema` are rejected for every stack runtime because the **shadow is always**
`EphemeralPostgres`, including `--linked` / `--db-url`.

### (d) Native dump, test, and squash clients

`db dump`, `db test`, and `migration squash` talk to published loopback credentials. On native
stacks they prefer `pg_dump` / `pg_dumpall` / `psql` from the prepared slim postgres artifact when
those extras exist in the cache. The extras are not catalog `requiredRuntimePaths`; missing them is
normal and the commands keep today's PATH clients and matching-major check. `pg_prove` stays a
PATH requirement; artifact `psql` is prepended when present so prove's client matches.

Windows still runs a one-shot Docker `pg_dump` / `pg_prove` client against the published URL
(`host.docker.internal`). The stack stays native. If Docker is missing on that Windows path, the
command fails and tells the user to install Docker Desktop (or Git Bash).

### (e) Studio does not require analytics

Compose runs Studio when `[analytics] enabled = false`. Stack compile allows that pairing so
bare `stack start` matches Compose. Studio’s capability and workload graphs do not list analytics
as a hard dependency; logs UI stays off when analytics is off. This is independent of schema
init, which never compiles Studio.

### (f) Live start setup is Compose-faithful

Compose keys “run full setup” on `volumeExists`. Stack has no compose volume, so the analog is
whether **this start created the stack identity** (first create / `unconfigured`).

- **First create**: schema init, Overlay (webhooks, grants, vault, `roles.sql`), then
  migrate-and-seed. `db start` and `stack start` share this. Do not report start success until
  it completes.
- **Existing cluster**: webhooks setup only. No schema-init retry, no grants/vault/`roles.sql`,
  no migrate-and-seed.
- If catalog or migrate-and-seed fails after the engine is already `running`, the command exits
  non-zero and Postgres stays up. The next start is an existing cluster and does not retry.
  Recover with `db reset`. Same stuck case as Compose after a failed fresh-volume setup.
- If the engine never reached `running`, lifecycle is written `unconfigured` before cleanup, so
  first-create survives both proven and unproven cleanup. Already-written secrets are kept;
  pass-through secrets may change while `unconfigured`. Leftover PGDATA/volume is not
  auto-wiped. A later launch that fails because remnants remain names `stack destroy` as the
  wipe. Cleanup only decides the in-process fence.

### Default runtime and native-as-root

Auto-selecting a **new** identity probes the Docker daemon (not only `docker --version`). A live
daemon persists Docker. A present client with a dead daemon persists **native** and prints a
notice that destroy-and-recreate (or a new `--stack` name) is required to get Docker later.
Persisted runtime never flips. Explicit `--runtime docker` still requires a live daemon.

Native Postgres is refused when the process uid is 0 (`initdb` refuses root). There is no
uid-drop. Use `--runtime docker`.

### Optional catalog downloads

Live schema-init still fail-closes the platform trio (auth, storage, realtime) against the
enabled/full config. Analytics and pooler one-shots follow the start/excluded config, so
`--exclude analytics` and postgres-only `db start` skip those downloads.

## Rationale

Throwaway full stacks would pollute discovery, pull in a Supervisor, and still need a
pre-start PGDATA inject. Duplicating native spawn in the CLI would fork artifact and bootstrap
logic. A package-level cluster keeps one Postgres lifecycle for native and container while
leaving schema policy in the CLI.

## Consequences

### Positive

- Native and Docker/Podman shadows share one API and the same slim baseline as `stack start`.
- Schema commands can target a running project stack through `credentials()` when the flag is on.
  `credentials().database` is available whenever the database listener is assigned, including when
  Auth is disabled. `credentials().api` is absent when Auth is off. Overlay and `--local` keep
  calling `credentials()`. There is no second RPC, and the CLI does not read secret slots.
- `resetDatabase` wipes Postgres without destroying the stack identity, so `db reset --local` and declarative `--apply` stay on the stack backend.
- Live `db start` / `stack start` setup matches Compose: full setup on first create, webhooks only afterwards.
- Legacy Docker behavior is unchanged when the flag is off.
- Windows native stacks can dump and squash without PostgreSQL client tools on PATH.

### Negative

- Cache tars cannot be shared across native and container runtimes.
- Migra/pgAdmin remain unavailable on stack backends (shadow is always ephemeral).
- A failed first live setup after the engine is running is stuck until `db reset`, same as
  Compose. A failed cold launch that never reached running retries first-create.
- Windows native dump/test/squash need a working Docker client even though Postgres itself is native.
- Native stacks as uid 0 cannot start; Docker (or a non-root user) is required.
- Auto-selected native after a dead Docker daemon is sticky until destroy or a new stack name.

## Alternatives Considered

1. **Database-only throwaway stacks** via `createStack`/`destroy`: extra Supervisor and
   registry identity for a tooling cluster; cache restore still needs a data inject.
2. **CLI-owned spawn**: Docker shadows with the slim image, CLI-spawned native binary. Forks
   catalog/bootstrap from the runtime package.
3. **`CREATE DATABASE` on the live cluster**: cannot snapshot independently or run two
   declarative plan servers.

## Related Decisions

- ADR 0017: Simplified managed stack architecture

## See Also

- [`packages/stack/README.md`](../../packages/stack/README.md)
- [`apps/cli/docs/stack-commands.md`](../../apps/cli/docs/stack-commands.md)
