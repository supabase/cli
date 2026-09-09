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

`SUPABASE_EXPERIMENTAL_STACK` / `[experimental].stack` select the stack backend for `db` and
`migration` as well as `start`/`stop`. Flag off keeps the legacy Docker shadow and
`supabase_db_*` local target. Linked / `--db-url` targets are unchanged. Top-level `status` is
not switched.

Shadow baseline for the stack backend is slim-init plus stack bootstrap, not the legacy SQL
templates. Cache files use a distinct `stack-shadow-baseline-*` namespace.

The stack backend requires the in-process pg-delta engine. Migra, pgAdmin, and
`--use-pg-schema` assume Docker networks or differ containers and are rejected for every
stack runtime.

## Rationale

Throwaway full stacks would pollute discovery, pull in a Supervisor, and still need a
pre-start PGDATA inject. Duplicating native spawn in the CLI would fork artifact and bootstrap
logic. A package-level cluster keeps one Postgres lifecycle for native and container while
leaving schema policy in the CLI.

## Consequences

### Positive

- Native and Docker/Podman shadows share one API and the same slim baseline as `stack start`.
- Schema commands can target a running project stack through `credentials()` when the flag is on.
- Legacy Docker behavior is unchanged when the flag is off.

### Negative

- `db reset` / declarative `--apply`/`--reset` still need a later stack data-wipe API.
- Cache tars cannot be shared across native and container runtimes.
- Migra/pgAdmin remain unavailable on stack backends.

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
