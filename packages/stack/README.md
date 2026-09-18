# `@supabase/stack`

The managed local Supabase runtime, with native and container backends. The package
accepts typed `StackConfig` inputs independently of the CLI. The CLI owns loading
`config.toml`, translating flags, and presenting results.

Supported entrypoints:

- `@supabase/stack`: Promise API.
- `@supabase/stack/effect`: Effect API with redacted secret inputs and outputs.
- `@supabase/stack/testing`: isolated test-stack helpers.

The package and its managed state are unreleased. Previous APIs and state formats
have no compatibility contract.

## Identities and instances

A stack identity contains a service registry, shared security material, endpoint
plans, and retained data. Its identity derives from the canonical project root,
Git branch context, and stack name. Separate worktrees and named stacks are
independent. Moving a project resolves a new identity.

`createStack` registers default instances from `initialConfig` without starting
workloads. Opening an existing stack preserves its registry and configuration.
Defaults are seeded once; destroying a default does not cause it to reappear.

```ts
import { createStack } from "@supabase/stack";

const stack = await createStack({
  projectRoot: process.cwd(),
  initialConfig: { preparation: "on-demand" },
});

const database = await stack.services.create({
  service: "database",
  name: "schema-comparison",
  config: {
    version: "17",
    activation: "eager",
    endpoints: { sql: { port: "auto" } },
  },
  initialization: { catalog: { auth: {}, storage: {}, realtime: {} } },
});

await database.start();
const credentials = await database.credentials();
if (credentials === undefined) throw new Error("SQL endpoint is disabled");
// Use credentials.url for SQL, then explicitly release the owned instance.
await database.destroy();
```

`stack.services` provides `create`, `get`, and `list`. `get({ id })` and
`get({ name })` only resolve an existing registration. Names are unique lookup
metadata; immutable IDs identify resources and dependency targets. Recreating a
name never revives its old handles or retargets dependents.

Dependent services bind typed dependency slots to existing instance IDs at
creation. Functions, PostgreSQL, and Mail have no service dependencies. Functions
can start while PostgreSQL and Auth are absent or stopped.

## Lifecycle

When `runtime` is omitted for a new stack, the package selects Docker when the Docker client is
installed and its daemon is reachable, and native otherwise. An installed client with an
unreachable daemon selects native, and the Effect handle carries a `dockerFallbackNotice` explaining
that the choice is persisted; switching to Docker later requires destroying the stack or choosing a
new stack name. The Promise facade does not expose the notice.
Native is refused when the process runs as uid 0. Existing stacks reuse their persisted runtime
without probing; native, Docker, and Podman preferences remain explicit when supplied, and an
explicit Docker runtime does not fall back. Podman is supported only on local Linux hosts.
Every instance exposes `describe`, `status`, `credentials`, `prepare`, `start`,
`sleep`, `stop`, `restart`, `destroy`, `logs`, `followLogs`, `followStatus`,
`exportSnapshot`, and `restoreSnapshot`.

| Operation             | Result                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| `start()`             | Make this instance and its prerequisite closure ready.                     |
| `sleep()`             | Retain started intent and wake routes while stopping workloads.            |
| `stop()`              | Fence demand activation and stop workloads; retain configuration and data. |
| `restart({ config })` | Apply optional replacement runtime settings and make the instance ready.   |
| `destroy()`           | Remove exact owned runtime resources and data, then remove registration.   |

`createTestStack` gives each test stack a unique temporary project root and identity while sharing
the managed state root used by ordinary package callers. It uses the same runtime selection as
`createStack`: a reachable Docker daemon selects Docker, and anything else selects native. Pass
`runtime: { kind: "native" }` or an explicit container runtime for reproducible test environments.
Automatic ports therefore
coordinate across all default callers. Helper project roots and identities remain isolated; a
temporary test stack is excluded from listings scoped to another project root but appears in an
unfiltered package `listStacks()` result. A failed destroy retains the affected project root and
managed state for recovery.
An explicit dependent start authorizes its prerequisite closure. Traffic-driven
activation cannot reverse a dependency's explicit stopped intent. Stop and restart
reject running or starting dependents outside the selection. Destroy also rejects
registered stopped dependents outside its selection.

Restart replaces supplied runtime settings rather than merging nested settings.
Omitted passwords and endpoint bindings retain their saved values. Initialization
requirements and dependency IDs are creation-time inputs and cannot be replaced
by restart.

Stack lifecycle methods accept an optional `{ services: [instanceId, ...] }`.
An explicit empty selection is a no-op. Selected start and restart make their
instances ready immediately; omitted selection applies whole-stack eager/lazy
policy. Whole start includes registered enabled dynamic instances as well as
defaults, while preserving unrelated already-ready services. Selected destroy
retains the stack identity; whole destroy removes it after proven cleanup.

`runPostgresClient` prepares that same catalog pin and runs caller argv (`bash -c` dump scripts,
`pg_prove`, …) without starting Postgres. Native prepends `artifact/bin` to `PATH`; container is a
one-shot `docker|podman run --rm`. It is not an `EffectStack` method, so linked dump can prepare
tools without a running stack.
PostgreSQL defaults to eager activation. Other services default to lazy
activation. Supported lazy services can retire after idle time; Functions and
PostgreSQL have no automatic idle timer. Manual sleep still requires a supported
wake route and rejects active traffic or protected dependency work.

## Ownership and observation

Handles are clients. Closing one, cancelling a request, or exiting the CLI does
not stop the shared runtime. A supervisor owns admitted lifecycle and snapshot
operations through settlement. Independent instances execute concurrently;
shared state transactions do not hold a lock across process startup or archive
I/O.

`followStatus` observes instance transitions, including pending operations and
recovery. `followLogs` follows the selected instance across workload replacements.
The Promise API returns async iterables; the Effect API returns streams. Stop
preserves retained logs and planned endpoints.

An owner that is retiring may reject a request before admission; the client waits
for its lease release and resolves a fresh owner once. An uncertain admitted
mutation is reported without replay. Callers creating resources should retain a
unique chosen name so they can reconcile an uncertain response through `get`.

Cleanup must be proven before an instance is removed. Failures retain attributable
recovery evidence. Client crashes may leave discoverable instances that require
explicit cleanup; there is no implicit age-based collection.

## Endpoints and security

Public HTTP, WebSocket, and SQL traffic uses the managed gateway. Container
Functions code also receives a tracked SQL route rather than a raw database
alias. Private endpoints are reserved for runtime-managed dependencies, health
checks, and setup work.

Creation plans stable client ports. A plan is not a bound socket or a readiness
promise. Binding an occupied saved port fails with a conflict instead of silently
changing the endpoint. Status distinguishes planned, listening, and unavailable
bindings. Individual lifecycle operations preserve unrelated listeners.

Set `endpoints.sql.enabled` to `false` to disable a database's public SQL binding.
Its `credentials()` then returns `undefined`; managed private consumers can still
use the database. Root database credentials project only the designated default
database and are absent when that instance or its enabled SQL binding is absent.

JWT signing material and expiry belong to stack security independently of Auth.
Each PostgreSQL instance owns its password. Descriptions redact secret settings;
credential methods are the explicit secret-bearing surface.

Functions inspector settings select `run`, `wait`, or `brk`, with optional `main`.
The instance's `endpoints.inspector` controls the managed inspector listener.
Startup-control HTTP and WebSocket endpoints may become available before
application health so a debugger can release a waiting runtime. Ordinary
Functions routes remain gated until ready.

`functions_root` is relative to the project root. Per-function entrypoints,
import maps, and static-file patterns are relative to that function's directory;
the shared import-map default is relative to `functions_root`. Explicitly
configured files may live outside the functions tree. Autodiscovery remains
contained within it. Container startup mounts source files read-only while
preserving their path relationships, including sibling imports. Restart resolves
the files again, so CLI watch restarts pick up source and configuration changes.

## Initialization and snapshots

PostgreSQL reconciles managed credentials and settings on every start, including
wake and restored data. Creation-time catalog requirements run before readiness,
independently of whether their corresponding live services are enabled. Durable
completion records are tied to the resolved initialization profile. Data existing
on disk alone is not evidence that catalog setup completed.

`StackConfig.initialization.database` supplies the designated primary's initial
requirements. Dynamic databases use `services.create({ initialization })`.
Use `initialization: { from: database.id }` to copy another database's resolved
catalog requirements within the same stack. The copy retains its requirements
after the source is destroyed and does not copy its data or completion receipts.
Project migrations, roles, seeds, and CLI overlays are outside the runtime
lifecycle.

Snapshot methods share the instance interface; PostgreSQL is the initial supported
service. Export requires stopped owned data and an absent destination. Restore
requires a stopped instance with empty storage and compatible runtime, PostgreSQL
format, and initialization profile.

Database data has four durable states: `absent` means no owned data is present, `fresh` carries
the lineage of a successful new initialization, `restored` carries the validated snapshot
descriptor, and `incomplete` carries the operation ID when storage completeness is unknown.
Starting absent or incomplete data records incomplete before mutation and promotes it to fresh on
success. A successful restore records restored; once marked incomplete, a failed restore retains
that state unless the runtime proves the target empty, in which case it records absent. Existing fresh or restored
provenance is preserved across ordinary restarts.

```ts
await database.stop();
const snapshot = await database.exportSnapshot({ destination: "/tmp/baseline.tar" });

// clone is a separately registered stopped database with matching requirements.
await clone.restoreSnapshot({ source: "/tmp/baseline.tar" });
await clone.start();
```

The snapshot descriptor records actual artifact/runtime identity, format,
initialization profile, provenance, and lineage. Clones have separate writable
data and instance IDs while preserving the baseline's lineage. Starting a clone
reconciles its own configured credentials. Native and container snapshots are
not interchangeable.

The target remains fenced during storage operations and recovery. Conflicting
commands fail instead of racing the archive. Publication never exposes a partial
snapshot. A caller finalizing a shadow waits for pending snapshot settlement
before destroying it, and reports unproven cleanup rather than hiding it.

## Preparation and testing

`prepare({ services?, config? })` prepares artifacts without changing saved
configuration, intent, listeners, or workloads. Candidate configuration previews
default instances; dynamic registrations retain their saved inputs. Startup
automatically prepares the artifacts it needs. Completed cache entries survive
operation cancellation.

The Effect API uses reusable Effect values for no-argument operations, including
`stack.services.list`, and functions for operations with options. Stack lifecycle
methods are functions because they accept selections. `followStatus` is a Stream
value; `followLogs(query?)` returns a Stream. The Promise facade uses functions
throughout.

Internal orchestration and CLI consumers use Effect directly. The package root
is the Promise facade for non-Effect consumers; internal code never calls it and
wraps its results back into Effects. Foreign Promise APIs are adapted at their
leaf boundaries.

`createTestStack` from `@supabase/stack/testing` returns an Effect and owns a unique
project root while sharing normal managed port coordination. Its
`setupProject(projectRoot)` callback also returns an Effect. Supply an explicit
native or container runtime for reproducible tests, and use
`Effect.acquireUseRelease` with `stack.destroy()` for cleanup. Non-Effect tests
can import `createTestStack` from the package root and use `await using`; that
adapter belongs to the same Promise facade as the ordinary stack API.
Whole-stack destruction removes the test root after successful managed cleanup;
selected service destruction retains it. A failed destroy retains its root and
state for recovery. Real runtime tests exercise public handles, managed gateways,
snapshots, and inspector startup in native and Docker modes.

See [the service-instance decision](../../docs/adr/0025-ephemeral-postgres-for-schema-tooling.md)
for the CLI shadow ownership and cache boundary.
