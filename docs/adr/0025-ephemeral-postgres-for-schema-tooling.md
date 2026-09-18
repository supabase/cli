# 0025. Registered service instances for schema tooling

**Status**: accepted
**Date**: 2026-09-16

## Context

Schema comparison needs independent PostgreSQL servers with isolated writable data.
Creating another database inside the primary server cannot provide independent
lifecycle, credentials, or physical snapshots. A separate shadow runtime would
duplicate process ownership, startup, bootstrap, and cleanup in the stack package.

The stack package and its stored state are unreleased. There is no compatibility
requirement for their previous API or state representation.

## Decision

One stack owns a registry of service instances. Each instance has an immutable ID,
an optional unique name, typed configuration, concrete dependency IDs, and owned
runtime resources. Primary and shadow PostgreSQL use the same implementation.
The package has no separate ephemeral PostgreSQL factory or database-only
lifecycle interface.

`stack.services` provides `create`, `get`, and `list`. Creation registers a stopped
instance and plans its endpoints without initializing data or starting a workload.
Every instance uses the same lifecycle and observation methods. Stack lifecycle
methods apply the same engine to an optional selection of instance IDs.

Names are lookup metadata. Destroying an instance and creating another under the
same name produces a different ID; dependency references and old handles cannot
retarget it. Default registrations are seeded once. Destroyed defaults remain
absent when a stack is reopened or restarted.

The supervisor owns admitted operations independently of requesting clients.
Per-instance admission protects lifecycle and storage operations, while unrelated
instances may start, restart, initialize, or snapshot concurrently. Shared state
commits update the current document and verify operation ownership. Slow process
work and archive I/O do not run under stack-wide state locks.

Every runtime resource carries its concrete instance identity. Catalog recipe
identity does not identify a running process, container, volume, private binding,
or setup helper. Targeted cleanup removes only proven instance-owned resources;
unproven cleanup retains recovery evidence.

## PostgreSQL initialization and snapshots

PostgreSQL reconciles managed passwords, JWT material, and settings on every
start, including wake and restored data. JWT material belongs to the stack and
does not require a running Auth service.

Creation-time database initialization selects typed catalog recipes. Their
resolved versions and inputs form a profile, and completion has a durable receipt
separate from the existence of PostgreSQL data. Catalog recipes target the exact
database instance and do not require their corresponding live services to run.
Project migrations, declarative schemas, roles, and overlays remain CLI work.
Database creation may reference another database's immutable ID to copy its
resolved initialization requirements within the stack. The new instance owns
its own initialization receipts and data. This lets CLI reset build a baseline
using the primary's catalog versions and secret inputs without exposing them.
Ordinary CLI shadows copy those requirements too, so repeated runs retain the
same resolved catalog inputs for cache lookup. A missing primary is an explicit
error; shadow creation does not recreate a destroyed default instance.

The uniform `exportSnapshot` and `restoreSnapshot` methods initially support
PostgreSQL. Export requires stopped data. Restore requires a stopped instance
with empty owned storage and compatible initialization, runtime, and data format.
The instance remains fenced through validation, publication, and helper cleanup.
An interrupted requester does not abandon the supervisor's storage operation.

Snapshots record resolved artifact and runtime metadata, PostgreSQL format,
initialization profile, provenance, and lineage. A restored clone preserves that
lineage while receiving a distinct instance ID and its own credentials. Native
and container snapshots are not interchangeable. Cache keys are CLI policy and
are not proof of shared database lineage. They combine resolved artifact, runtime,
bootstrap, and initialization identities with CLI overlay inputs. Endpoint ports
and instance paths do not affect bootstrap identity.

## CLI integration

`db dump`, `db test`, and `migration squash` talk to published loopback credentials for
`--local`. On the stack backend, dump, squash, and `test db` always launch catalog `pg_dump` /
`pg_dumpall` / `pg_prove` (native: `PATH` prepend of `artifact/bin`; container or
no-native-artifact platforms: a one-shot of the same catalog image). Native
`--linked` / `--db-url` keep the resolved host instead of rewriting it to loopback.
Windows and Intel Mac have no native postgres artifact, so dump/squash/prove run a one-shot
Docker client against the published URL (`host.docker.internal`). The stack stays native.
If Docker is missing on that path, the command fails and tells the user to install Docker
Desktop. `db lint --local` does not launch a client binary: catalog Postgres ships
`plpgsql_check`, so the lint transaction can `CREATE EXTENSION` on native and container stacks.
The CLI chooses and retains a fresh shadow name before creation. After an uncertain
create response, it looks up that name and verifies the intended creation inputs
before treating the registration as owned. It does not blindly replay creation.
A creation-input digest on the uncertain result and the registration proves the
complete normalized request matches, including secret inputs without revealing
them. Missing or different evidence leaves the registration unclaimed.

The cold flow creates and starts a registered database, applies CLI overlays,
optionally stops and exports a baseline, then starts it for migrations and
comparison. The cache flow restores a compatible baseline into a fresh stopped
instance before starting it. Cache fallback first proves cleanup of the failed
target, then creates a fresh instance.

CLI finalization waits for an admitted snapshot operation to settle before
destroying its instance. Cleanup failure is reported with the retained instance;
it is not hidden as successful disposal. A crashed CLI may leave a discoverable
registration for explicit cleanup.

Clients use planned managed SQL endpoints instead of choosing ports themselves.
All public SQL traffic traverses the stack TCP gateway. Private backend
connections are limited to runtime-managed dependency and setup work. Native
tool selection uses resolved artifact metadata and retains matching-major checks
without exposing runtime-owned data paths.

The stack backend remains selected by the existing experimental CLI policy.
Linked and explicit database URLs keep their connection semantics. Existing CLI
behavior outside the stack backend does not require a second stack lifecycle.

## Consequences

- Primary and shadow databases share initialization, runtime, and cleanup behavior.
- Two shadows can coexist while Functions restarts independently of their work.
- Stable endpoint plans survive stop and sleep; external port conflicts fail
  explicitly rather than relocating saved URLs.
- Explicit sleep retains started intent and gateway wake; stop fences wake and
  retains data; destroy removes registration only after proven cleanup.
- Whole-stack operations include registered shadows, including those left by a
  crashed CLI. Shadows have no automatic age-based cleanup.
- Previous unreleased stack APIs and stored formats are removed without adapters
  or migrations. The new model retains safeguards for data created within it.

## Related decisions

- [Managed stack architecture](0017-simplified-managed-stack-architecture.md)
- [Stack package API](../../packages/stack/README.md)
- [CLI stack commands](../../apps/cli/docs/stack-commands.md)
