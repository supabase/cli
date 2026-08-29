# Supabase Local Stack Runtime Architecture

Status: final greenfield architecture
Last updated: 2026-08-29

## Goals and scope

`@supabase/stack` defines, prepares, runs, observes, stops, restarts, and destroys one local
Supabase stack. It supports a strict native or container runtime split behind one public contract.
The runtime choice is made when an identity is created, is immutable for that identity, and all
workloads use the same runtime. Native and container execution never mix workloads.
The package supports managed stacks only: callers receive handles to a Supervisor-owned identity,
not ownership of an independently launched process or container.

The package must let callers:

- run isolated stacks for projects, branches, worktrees, and named instances;
- keep a running stack alive after every creating process exits;
- stop and explicitly restart without changing identity, data, runtime, versions, secrets, or
  sticky automatic ports unless the restart explicitly supplies an allowed stopped-time change;
- change resolved settings, capability membership, activation policy, listeners, and exact ports
  only at a stop boundary;
- prepare artifacts without creating runtime resources or starting services;
- use eager or mandatory-lazy capabilities through one gateway;
- edit and invoke Edge Functions from the host while the stack remains managed;
- discover stacks without claiming ownership or starting work; and
- recover or replace a compatible Supervisor without silently replacing a healthy owner.

The package does not parse `config.toml`, run project migrations or seeds, expose Compose, or act as
a general process orchestrator. The CLI resolves its configuration and calls the package API.

## Settled design decisions

These decisions are closed for this rewrite:

- `createStack` returns an ordinary managed handle. A separate testing helper creates, starts, and
  destroys an isolated stack and is the only API designed for `await using`.
- Only managed stacks are supported. There is no foreground/unmanaged ownership mode.
- A materialized definition persists every resolved value, including defaults and explicit
  absences. Reopening a stack therefore never reinterprets old state through newer defaults.
- Calling `start` on an already-running stack is idempotent only for the same materialized input.
  Incompatible input fails with guidance to use explicit `restart`; it is never applied on top of a
  running stack.
- Lazy activation is mandatory. Once activated, a capability remains active for that generation;
  there is no idle eviction.
- Native and container stacks are strictly separate, and every catalog workload has both a native
  and a container artifact. One stack identity can never mix them.
- Functions have exactly one serving path: the stack-owned Edge Runtime. This applies to normal
  stack traffic and `supabase functions serve`; there is no separate Docker or standalone serving
  workflow. `functionsRoot` is the only host root and the only read-only container mount, and every
  resolved path must remain beneath it.
- The Promise facade exposes secret-bearing values as plain strings. Redacted values remain an
  Effect-side concern.
- Each capability accepts the complete set of supported per-service settings; the compiler rejects
  unknown fields and persists the complete resolved result.
- Database version selection resolves only to an exact database artifact supported by the catalog.
  An unknown selector fails before mutation. Internal bootstrap revisions are implementation-owned,
  ordered steps selected by that exact artifact; they are not a second public version input.
- Corrupt durable state fails closed. Logs redact every exact known secret and never persist or emit
  full secret environments, files, or arguments.
- There is no all-in-one `resetDatabase` operation. Stack owns lifecycle fencing, data recreation,
  and internal bootstrap; the caller owns migrations, declarative schemas, and seeds through the
  narrow reset-session API designed in the final behavioral slice of the rewrite.

The design follows the object-level separation used by Docker without copying its CLI:

```text
CLI-resolved StackConfig
          │
          ▼
StackCompiler ──► materialized StackDefinition + runtime ExecutionPlan
          │                               │
          ▼                               ▼
 durable state/fingerprint          per-stack Supervisor
                                          │
                                   StackReconciler
                                    │            │
                                    ▼            ▼
                               ArtifactStore  RuntimeDriver
                                             native | container
                                                    │
                                                    ▼
                                             StackGateway
                                         HTTP and transparent TCP
```

## Core invariants

- One `StackId` has at most one live Supervisor and one owned control endpoint.
- A running Supervisor and its workloads outlive every caller handle. Closing a handle only
  releases that handle, its subscriptions, and its facade-owned scope.
- `createStack` and `openStack` return ordinary managed-stack handles. Promise handles are explicitly
  closed and are not `AsyncDisposable`; `await using` is reserved for the isolated testing helper.
  Closing a handle never stops or destroys the managed stack.
- Every accepted desired-state mutation has one durable `desiredGeneration`; equivalent concurrent
  callers join the same owner operation.
- Only the Supervisor mutates one stack and it executes at most one reconciliation plan at a time.
- Canceling a caller wait never cancels Supervisor-owned start, stop, restart, preparation,
  activation, or destruction work.
- A stopped stack has no live processes, service containers, gateway, private network, or published
  listeners. It retains its state, data, logs, artifacts, secrets, and logical port records.
- Runtime kind and engine, materialized definition, input fingerprint, exact capability versions,
  managed secrets, and selected automatic ports are sticky until an allowed stop-time change.
- Public listeners belong only to `StackGateway`; backend workloads use private endpoints.
- Runtime adoption requires `StackId`, `desiredGeneration`, and a semantic workload-spec hash that
  matches the current compiler output. Compiler changes cannot adopt incompatible old resources.
- Destroy removes the complete stack and all of its data. Cleanup is exact-identity-only.
- Lazy activation is one-way per generation: once a capability is activated, it remains desired
  active and its workloads use catalog restart policy until stop or explicit restart. There is no
  idle eviction.

## Public model and API

`@supabase/stack/effect` is Effect-native end to end. The package root is a thin Promise and
`AsyncIterable` facade; no internal helper returns a Promise.

```ts
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

declare const StackIdTypeId: unique symbol;
type StackId = string & { readonly [StackIdTypeId]: "StackId" };

type StackRuntime =
  | { readonly kind: "native" }
  | { readonly kind: "container"; readonly engine: "docker" | "podman" };

type StackRuntimePreference =
  | { readonly kind: "native" }
  | { readonly kind: "container"; readonly engine?: "docker" | "podman" | "auto" };

type CapabilityName =
  | "database"
  | "rest"
  | "auth"
  | "realtime"
  | "storage"
  | "functions"
  | "studio"
  | "mail"
  | "analytics"
  | "pooler";

type CapabilityState =
  "disabled" | "dormant" | "preparing" | "starting" | "ready" | "stopping" | "stopped" | "failed";

type StackLifecycle =
  | "unconfigured"
  | "stopped"
  | "starting"
  | "running"
  | "resetting-database"
  | "stopping"
  | "destroying";

type DesiredStackLifecycle = "unconfigured" | "stopped" | "running" | "destroying";
type ActivationMode = "eager" | "lazy";
type PortField = keyof StackListenersConfig;

interface StackEndpoint {
  readonly protocol: "http" | "tcp";
  readonly address: string;
  readonly port: number;
  readonly url: string;
}

interface CapabilityStatus {
  readonly name: CapabilityName;
  readonly activation: ActivationMode;
  readonly state: CapabilityState;
  readonly error?: string;
}

/** Complete point-in-time projection used by both info and watch. */
interface StackStatus {
  readonly id: StackId;
  readonly lifecycle: StackLifecycle;
  readonly desiredLifecycle: DesiredStackLifecycle;
  readonly runtime: StackRuntime;
  readonly desiredGeneration?: number;
  readonly endpoints: Readonly<Partial<Record<PortField, StackEndpoint>>>;
  readonly versions: Readonly<Partial<Record<CapabilityName, string>>>;
  readonly capabilities: ReadonlyArray<CapabilityStatus>;
}

interface LogCursor {
  readonly opaque: string;
}

interface LogOptions {
  readonly capabilities?: ReadonlyArray<CapabilityName>;
  readonly follow?: boolean;
  readonly cursor?: LogCursor;
}

interface StackLogEntry {
  readonly cursor: LogCursor;
  readonly timestamp: string;
  readonly source: CapabilityName | "supervisor" | "gateway";
  readonly stream: "stdout" | "stderr" | "internal";
  readonly message: string;
}

interface StackDescriptor {
  readonly id: StackId;
  readonly projectRoot: string;
  readonly name: string;
  readonly branchContext: string;
  readonly runtime: StackRuntime;
  readonly desiredLifecycle: DesiredStackLifecycle;
}

interface StackInspection {
  readonly descriptor: StackDescriptor;
  readonly owner: "running" | "absent" | "unreachable" | "incompatible";
  readonly status?: StackStatus;
}
```

`StackStatus` is a complete projection, not an event delta. `status()` returns one projection and
`watchStatus()` is a stream whose every subscription begins with the current complete projection and
then publishes complete meaningful snapshots. There is no sequence-number event union and no
duplicate projection or delta API. Health is derived from capability states, not a separate lifecycle
value. Logs remain a separate retained-to-live stream with an opaque cursor.

### Closed capability settings

`StackConfig` contains a closed `StackCapabilitiesConfig`, `StackListenersConfig`, and security
policy. Every setting accepted by CLI configuration is represented in a schema-derived type; a
capability's schema is exhaustive, not an open property map or a partial provider example.

```ts
interface StackConfig {
  readonly capabilities?: StackCapabilitiesConfig;
  readonly listeners?: StackListenersConfig;
  readonly security?: StackSecurityConfig;
}

interface StackCapabilitiesConfig {
  readonly database?: DatabaseCapabilityConfig;
  readonly rest?: OptionalCapabilityConfig<RestSettings>;
  readonly auth?: OptionalCapabilityConfig<AuthSettings>;
  readonly realtime?: OptionalCapabilityConfig<RealtimeSettings>;
  readonly storage?: OptionalCapabilityConfig<StorageSettings>;
  readonly functions?: OptionalCapabilityConfig<FunctionsSettings>;
  readonly studio?: OptionalCapabilityConfig<StudioSettings>;
  readonly mail?: OptionalCapabilityConfig<MailSettings>;
  readonly analytics?: OptionalCapabilityConfig<AnalyticsSettings>;
  readonly pooler?: OptionalCapabilityConfig<PoolerSettings>;
}

type OptionalCapabilityConfig<Settings> =
  | { readonly enabled: false }
  | {
      readonly enabled?: true;
      readonly activation?: ActivationMode;
      readonly version?: string;
      readonly settings?: Settings;
    };

interface DatabaseCapabilityConfig {
  readonly version?: string;
  readonly settings?: DatabaseSettings;
}

interface StackSecurityConfig {
  readonly jwt?: JwtSecurityConfig;
}

interface JwtSecurityConfig {
  readonly issuer?: string;
  readonly signing?: JwtSigningConfig;
}

type JwtSigningConfig =
  | { readonly kind: "symmetric"; readonly secret: Redacted.Redacted<string> }
  | { readonly kind: "jwks-file"; readonly path: string };

// These aliases stand for generated closed schemas. Each generated declaration
// contains every supported field, defaults, validation, secret classification,
// and native/container artifact mapping for that capability.
type RestSettings = GeneratedSettingsSchema<"rest">;
type AuthSettings = GeneratedSettingsSchema<"auth">;
type RealtimeSettings = GeneratedSettingsSchema<"realtime">;
type StorageSettings = GeneratedSettingsSchema<"storage">;
type FunctionsSettings = GeneratedSettingsSchema<"functions">;
type StudioSettings = GeneratedSettingsSchema<"studio">;
type MailSettings = GeneratedSettingsSchema<"mail">;
type AnalyticsSettings = GeneratedSettingsSchema<"analytics">;
type PoolerSettings = GeneratedSettingsSchema<"pooler">;
type DatabaseSettings = GeneratedSettingsSchema<"database">;
```

The code comment above is notation for schema-derived declarations, not a literal suggestion to
erase fields. Each capability Module owns its full settings schema, defaulting, validation, secret
classification, native artifact mapping, container artifact mapping, and workload compilation.
Auth providers, mail modes, storage options, and every other catalog-supported field are described
by those modules rather than by incomplete architecture examples.

Listeners use the closed shape below. Omitted ports request an automatic assignment; an explicit
port is an exact assignment.

```ts
interface StackListenersConfig {
  readonly api?: ListenerConfig;
  readonly database?: ListenerConfig;
  readonly pooler?: ListenerConfig;
  readonly studio?: ListenerConfig;
  readonly mailUi?: ListenerConfig;
  readonly smtp?: ListenerConfig;
  readonly pop3?: ListenerConfig;
  readonly functionsInspector?: ListenerConfig;
}

type ListenerConfig =
  | { readonly enabled: false }
  | { readonly enabled?: true; readonly address?: string; readonly port?: number };
```

### Effect and Promise entry points

```ts
interface EffectStackCredentials {
  readonly database: {
    readonly url: Redacted.Redacted<string>;
    readonly password: Redacted.Redacted<string>;
  };
  readonly api: {
    readonly publishableKey: string;
    readonly secretKey: Redacted.Redacted<string>;
    readonly anonJwt: string;
    readonly serviceRoleJwt: Redacted.Redacted<string>;
  };
  readonly storage?: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: Redacted.Redacted<string>;
  };
}

interface PromiseStackCredentials {
  readonly database: { readonly url: string; readonly password: string };
  readonly api: {
    readonly publishableKey: string;
    readonly secretKey: string;
    readonly anonJwt: string;
    readonly serviceRoleJwt: string;
  };
  readonly storage?: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
}

interface StartStackOptions {
  readonly config?: StackConfig;
}
interface PrepareStackOptions {
  readonly config?: StackConfig;
  readonly capabilities?: ReadonlyArray<CapabilityName>;
}
interface CreateStackOptions {
  readonly projectRoot: string;
  readonly name?: string;
  readonly runtime?: StackRuntimePreference;
}
interface FindStackOptions {
  readonly projectRoot: string;
  readonly name?: string;
}
interface ListStacksOptions {
  readonly projectRoot?: string;
}

/** Generated Promise counterpart: every Redacted<string> leaf is a plain string. */
type PromiseStackConfig = GeneratedPromiseStackConfig;
type PromiseStartStackOptions = { readonly config?: PromiseStackConfig };
type PromisePrepareStackOptions = {
  readonly config?: PromiseStackConfig;
  readonly capabilities?: ReadonlyArray<CapabilityName>;
};

interface PreparedCapability {
  readonly capability: CapabilityName;
  readonly version: string;
  readonly outcome: "cached" | "downloaded" | "pulled";
}
interface PrepareStackResult {
  readonly capabilities: ReadonlyArray<PreparedCapability>;
}

interface EffectStack {
  readonly id: StackId;
  readonly status: () => Effect.Effect<StackStatus, StackStatusError>;
  readonly credentials: () => Effect.Effect<EffectStackCredentials, StackCredentialsError>;
  readonly prepare: (
    options?: PrepareStackOptions,
  ) => Effect.Effect<PrepareStackResult, StackPreparationError>;
  readonly start: (options?: StartStackOptions) => Effect.Effect<StackStatus, StackStartError>;
  readonly restart: (options?: StartStackOptions) => Effect.Effect<StackStatus, StackRestartError>;
  readonly stop: () => Effect.Effect<void, StackStopError>;
  readonly destroy: () => Effect.Effect<void, StackDestructionError>;
  readonly close: () => Effect.Effect<void, StackCloseError>;
  readonly watchStatus: () => Stream.Stream<StackStatus, StackStatusWatchError>;
  readonly logs: (options?: LogOptions) => Stream.Stream<StackLogEntry, StackLogsError>;
}

function createStack(
  options: CreateStackOptions,
): Effect.Effect<EffectStack, CreateStackError, Scope.Scope>;
function openStack(id: StackId): Effect.Effect<EffectStack, OpenStackError, Scope.Scope>;
function findStack(
  options: FindStackOptions,
): Effect.Effect<Option.Option<StackDescriptor>, StackDiscoveryError>;
function listStacks(
  options?: ListStacksOptions,
): Effect.Effect<ReadonlyArray<StackDescriptor>, StackDiscoveryError>;
function inspectStack(
  id: StackId,
): Effect.Effect<StackInspection, StackNotFoundError | StackDiscoveryError>;

declare namespace PromiseApi {
  interface Stack {
    readonly id: StackId;
    readonly status: () => Promise<StackStatus>;
    readonly credentials: () => Promise<PromiseStackCredentials>;
    readonly prepare: (options?: PromisePrepareStackOptions) => Promise<PrepareStackResult>;
    readonly start: (options?: PromiseStartStackOptions) => Promise<StackStatus>;
    readonly restart: (options?: PromiseStartStackOptions) => Promise<StackStatus>;
    readonly stop: () => Promise<void>;
    readonly destroy: () => Promise<void>;
    readonly close: () => Promise<void>;
    readonly watchStatus: () => AsyncIterable<StackStatus>;
    readonly logs: (options?: LogOptions) => AsyncIterable<StackLogEntry>;
  }

  function createStack(options: CreateStackOptions): Promise<Stack>;
  function openStack(id: StackId): Promise<Stack>;
  function findStack(options: FindStackOptions): Promise<StackDescriptor | undefined>;
  function listStacks(options?: ListStacksOptions): Promise<ReadonlyArray<StackDescriptor>>;
  function inspectStack(id: StackId): Promise<StackInspection>;
}
```

The Promise facade mechanically runs the Effect contract in one private scope per handle, maps
`Option` to `undefined`, adapts `Stream` to `AsyncIterable`, and translates `Redacted` values to
plain strings at the outer boundary. `GeneratedPromiseStackConfig` is a generated closed counterpart
of `StackConfig` with every secret leaf represented as `string`, including all capability settings;
it is not an open property map. Secret-bearing types are therefore intentionally different;
the facade does not claim that every shared type is identical. Ordinary Promise handles require an
explicit idempotent `close()` when the caller wants to release handle-local resources. They do not
implement `AsyncDisposable`, because `await using` is reserved for the test helper that owns and
destroys a unique test identity.

`createStack` canonicalizes the project root, resolves the stable identity, persists a concrete
runtime for a new identity, starts or attaches to its Supervisor, and returns a handle. It does not
read configuration, allocate ports, prepare artifacts, or start workloads. `openStack` attaches only
to an existing opaque id and never creates an identity. `close` is idempotent and never stops a
managed stack.

`findStack`, `listStacks`, and `inspectStack` are read-only. Inspection may include the durable
descriptor and a compatible observed `StackStatus` when an owner is reachable; it never claims
ownership, starts work, or recovers resources. A new identity that has never accepted a definition
has desired lifecycle `unconfigured`.

### Testing helper

`@supabase/stack/testing` exposes a high-level `createTestStack` helper. It creates a unique isolated
managed identity in a temporary root, starts it, waits for readiness, and returns an
`AsyncDisposable` test resource wrapper (distinct from an ordinary `createStack`/`openStack` handle)
whose disposal destroys, rather than merely closes, that identity. The helper records the exact
identity it created, never attaches to existing user state, and destroys only that identity. If
startup fails, it cleans every partial resource and state record it owns before rejecting. This
helper is the sanctioned test setup for public integration scenarios.

```ts
await using stack = await createTestStack({ config });
// The stack is ready here. Leaving the scope destroys this exact test identity.
```

## Identity

Identity is resolved before runtime ownership:

```text
workspaceId + checkoutId + branchContext + localProjectKey + stackName → StackId
```

`workspaceId` identifies the repository or ordinary workspace, `checkoutId` the concrete checkout
or worktree, `branchContext` the full branch ref (or `detached`/`ordinary-workspace`),
`localProjectKey` the normalized project path relative to checkout root, and `stackName` an explicit
instance selector defaulting to `default`. `StackId` is an opaque digest of this tuple. A branch
rename creates a new identity; switching branches never stops the previous stack.

The user-local registry enumerates state documents and serializes identity and port transactions
with one short cross-process lock. It is not a daemon. State, data, logs, runtime names, labels,
control endpoint, and logical ports are all namespaced by exact `StackId`.

## Materialized configuration and lifecycle

### Compilation and durable definition

The CLI resolves `config.toml`, flags, environment interpolation, and secret redaction into
`StackConfig`. At `start` or `prepare`, an Effectful leaf snapshots referenced non-secret auxiliary
files. Live Function code and secret files are not snapshotted.

```ts
interface StackDefinition {
  /** Every capability is present with enabled, activation, version, and defaulted settings. */
  readonly capabilities: {
    readonly database: MaterializedCapability<MaterializedSettings<"database">>;
    readonly rest: MaterializedCapability<MaterializedSettings<"rest">>;
    readonly auth: MaterializedCapability<MaterializedSettings<"auth">>;
    readonly realtime: MaterializedCapability<MaterializedSettings<"realtime">>;
    readonly storage: MaterializedCapability<MaterializedSettings<"storage">>;
    readonly functions: MaterializedCapability<MaterializedSettings<"functions">>;
    readonly studio: MaterializedCapability<MaterializedSettings<"studio">>;
    readonly mail: MaterializedCapability<MaterializedSettings<"mail">>;
    readonly analytics: MaterializedCapability<MaterializedSettings<"analytics">>;
    readonly pooler: MaterializedCapability<MaterializedSettings<"pooler">>;
  };
  readonly listeners: MaterializedListenersConfig;
  readonly security: MaterializedSecurityConfig;
}

interface MaterializedCapability<Settings> {
  readonly enabled: boolean;
  readonly activation: ActivationMode;
  readonly version: string;
  readonly settings: Settings;
}

/** Generated closed settings with every default applied and each secret leaf replaced by a slot. */
type MaterializedSettings<Name extends CapabilityName> = GeneratedMaterializedSettingsSchema<Name>;
type MaterializedListenersConfig = GeneratedMaterializedListenersSchema;
type MaterializedSecurityConfig = GeneratedMaterializedSecuritySchema;

type InputFingerprint = string & { readonly __inputFingerprint: unique symbol };
```

The pure compiler produces a fully resolved non-secret `StackDefinition`, a canonical non-secret
`inputFingerprint`, resolved secret inputs keyed by generated slots, and an in-memory runtime-specific
execution plan. The definition contains every logical value, including defaults, explicit capability
settings, activation, listener policy and port intent, security policy, versions, and secret-slot
references. Actual port assignments and secret bytes are persisted once in their dedicated state
fields. Together these fields are the complete materialized state; defaults are never reconstructed
during recovery. The fingerprint preserves explicit choices, omissions, normalized paths,
auxiliary-source digests, and secret shape/presence without any secret bytes.

The private execution plan derives dependencies, reverse-stop ordering, routes, mounts, probes,
runtime ids, workload ids, semantic workload-spec hash, and concrete artifact keys. These are private
runtime state and are never durable public configuration. Every compiled workload release maps to
both a native artifact and a container artifact; the concrete key is selected only by the immutable
runtime and platform.

Fingerprint rules are strict:

1. An identical fingerprint reuses the exact persisted materialized definition even if package
   catalog defaults or compiler code have changed.
2. A changed fingerprint is rejected while the stack is running with
   `StackMustBeStoppedError`, even when current defaults would resolve the candidate to the same
   definition. The running owner is never replaced implicitly.
3. While stopped, a changed fingerprint resolves a complete new definition against current
   defaults and persists definition and fingerprint atomically after full validation.
4. A changed stopped definition retains only explicitly sticky values permitted by the state model:
   runtime, exact capability versions from the previous definition, managed secrets, and unchanged
   port assignments.

Secret comparison is independent of the non-secret fingerprint. Managed secret omissions reuse the
persisted value and conflicting supplied values fail in every lifecycle state. Pass-through secret
declarations may change only while stopped, including when the non-secret fingerprint is unchanged.

The compiler and all capability Modules validate unsupported exact versions and artifact mappings
before mutation. Artifact availability is not compatibility. Public version identifiers are
runtime-neutral release names; private artifact keys include runtime and platform details.

### Start, stop, and explicit restart

`start({ config })` and explicit `restart({ config })` are the only operations that apply
configuration. On an unconfigured identity, `start()` uses current defaults, materializes a
definition, and requires no caller secret. A configured identity with omitted config reuses its
persisted fingerprint and definition. A valid stopped start commits the complete definition,
fingerprint, ports, secrets, and a new running `desiredGeneration` atomically before reconciliation.

On a compatible running stack, `start` first compares any supplied config and secrets. An identical
request is idempotent and returns the current `StackStatus`; any change fails with
`StackMustBeStoppedError`. If the owner or RPC release is incompatible, `start` fails with
`StackUpgradeRequiredError` and tells the CLI caller to run `supabase restart`; `start`, `openStack`,
`status`, and `logs` never replace an owner.

`restart(options?)` is explicit and requires desired lifecycle `running`. It preflights and decodes
durable state, session-fences and quiesces the old owner through the stable maintenance protocol,
waits for ownership release, then launches the current Supervisor. It may apply newly resolved
stopped-time configuration from `options` only after the old owner has stopped at the fenced point.
Identity, data, runtime, managed secrets, and unchanged sticky records are preserved. Allowed
stopped-time options may change settings, capability versions other than an initialized database,
pass-through secrets, and exact port requests. An explicitly concurrent `stop` wins;
it fences the generation and prevents a delayed restart from relaunching the stack.

`stop()` accepts a stopped `desiredGeneration`, rejects new activation, drains gateway traffic,
stops dependents in reverse dependency order, terminates exact native process trees or removes exact
containers, removes gateway/network resources, closes live listeners, and atomically retains logs.
It retains state, data, definitions, fingerprints, secrets, versions, ports, and cached artifacts.
Caller exit never rolls back durable running intent; the Supervisor continues reconciliation.

`destroy()` fences destroying, completes or supersedes owner work at a safe boundary, removes exact
runtime resources and all data/logs, and deletes the state document under the registry lock. There
is no retain-data variant.

### Versions and database immutability

The first accepted definition persists an exact version for every enabled capability. Omitted
versions reuse existing pins; a newly enabled capability selects the current catalog release. A
stopped edit may change a non-database pin. Database version becomes immutable after database data
initialization. An exact unsupported version fails before state or data mutation; an available
artifact is not evidence of compatibility. Changing an initialized database version requires
destroy/recreate or a future explicit upgrade workflow.

Internal database bootstrap is an idempotent readiness phase of the real database workload, not a
synthetic companion workload. Its ordered revision plan is selected from the exact pinned database
release, and tracking is stored inside the database, never in `state.json`. Bootstrap creates the
internal roles, passwords, extensions, schemas, and grants required by that pinned release. The
database cannot become ready—and therefore no dependent can activate—until the plan completes.

## Durable state, secrets, and logs

Each identity has one authoritative owner-only document:

```text
<stack-state-root>/<StackId>/state.json
```

Its public shape is conceptually:

```ts
interface PersistedStackState {
  readonly format: "supabase-stack-state-v1";
  readonly identity: PersistedStackIdentity;
  readonly runtime: StackRuntime;
  readonly desiredGeneration: number;
  readonly desiredLifecycle: DesiredStackLifecycle;
  readonly definition?: StackDefinition;
  readonly inputFingerprint?: InputFingerprint;
  readonly ports: ReadonlyArray<HostPortAssignment>;
  readonly secrets: PersistedSecretValues;
}

/** Generated closed schema for all managed and pass-through secret leaves. */
type PersistedSecretValues = GeneratedPersistedSecretSchema;
```

The durable definition is fully materialized and contains no PIDs, timestamps, runtime ids,
workload graph, routes, mounts, probes, concrete artifact keys, or secret bytes. Runtime-specific
execution plans are rebuilt on recovery. Exact capability versions have one durable representation:
the materialized definition. Concrete port assignments and managed/pass-through secret bytes live
only in their dedicated fields.

Every mutation validates the expected generation, builds one complete next value, writes an owner-only
temporary sibling, fsyncs as required by the platform, and atomically replaces `state.json`. A crash
therefore exposes either the complete old or complete new value. Missing or corrupt state beside
exact identity-owned data, logs, or runtime resources fails closed with `StackStateInvalidError`.
Ordinary create/open/start/destroy paths never overwrite or guess replacement state. A separate,
explicitly destructive recovery/cleanup operation may remove exact `StackId`-owned remnants after
deliberate authorization; it is outside ordinary lifecycle operations.

Stack-managed secrets include database and internal-role passwords, JWT signing material, encryption
keys, and generated API credentials. Omission generates each required value once; a different later
value fails with `StackSecretMismatchError` in every lifecycle state. Caller-owned pass-through
secrets (SMTP, OAuth, and Function secret environment) are complete declarations and can be added,
replaced, or removed only while stopped. Effect APIs use `Redacted`; the Promise facade unwraps to
plain strings only at its public boundary.

Known exact managed and pass-through secret strings are redacted before persistence or streaming
logs. The implementation never logs full environment maps, secret files, or secret arguments. Logs
remain potentially sensitive because transformed or derived values cannot be guaranteed to match
every secret. Log files are owner-only, bounded, and rotated. A `LogCursor` identifies retained
position; the retained-to-live handoff is atomic so a follower sees each entry at most once without
a gap.

### State format evolution

The first release reads and writes only `supabase-stack-state-v1`; it has no readers for prior
development formats. Once a second concrete format ships, that release must decode the still-
supported earlier format and atomically migrate the complete document before reconciliation. Use one
explicit decoder/migration per released format; do not add a generic migration framework or downgrade
guarantee. An unsupported or semantically invalid format fails closed, while the stable maintenance
stop remains available to stop a live owner.

## Capabilities and private workloads

The public surface names only the ten `CapabilityName` values and aggregates each capability into a
`CapabilityState`. Internally, a capability Module compiles one or more private workloads. Examples
include storage plus imgproxy, studio plus pgmeta, and analytics plus vector. Database bootstrap is
deliberately different: it is a post-probe readiness phase on the real database workload and never
has its own workload id, artifact, process, lifecycle, or dependency node.
Workload ids drive labels, artifact selection, exact cleanup, readiness, internal log routing,
dependency edges, and restart policy. Public log entries are attributed to their capability rather
than exposing workload ids. Capability state is an aggregation of its workloads; an individual
failed workload does not erase unrelated capability state.

Each workload release has both native and container mappings. A strict runtime split means a
StackId is entirely native or entirely container and no workload can be switched across runtimes in
place. Unsupported runtime/platform artifact mappings fail before mutation.

## Ownership, control, and recovery

The Supervisor proves ownership with one atomic primitive (an exact private endpoint bind or an
advisory lock) and records a random `ownerSessionId`. The same owned endpoint carries two
versioned protocols:

- `OwnerMaintenanceControl` is a frozen bounded-JSON protocol for probe, stable stop, and quiesce/
  replacement. Stable maintenance stop is the sole stop mechanism that must work across releases.
- Exact-release `StackControlRpc` is Effect RPC for handles, preparation, status/watch, credentials,
  logs, start, restart, and destroy. Its release is pinned and version-gated. It deliberately does
  not expose stop; stop always goes through the stable maintenance operation.

Both controls share the one owned endpoint; no parallel maintenance channel exists. RPC handlers
submit work to the Supervisor and never become lifecycle owners. Protocol mismatch is an upgrade
signal, not an implicit replacement:
the client decodes and validates state, asks the old owner to quiesce only after preflight, waits for
release, launches the current Supervisor, and reconciles the accepted generation. If preflight
fails, old owner and runtime remain untouched. Errors distinguish unsupported state format from
replacement failure.

Recovery after attachment or reboot is explicit. The new owner decodes complete state and recompiles
the persisted `StackDefinition` before inspecting only exact native/container resources. It removes
leftover ephemeral resources for stopped state, and for running state adopts resources carrying
matching `StackId`, `desiredGeneration`, and semantic workload-spec hash. Native work starts clean;
containers with stale hashes are removed and recreated.
Persistent volumes are identity-scoped and survive stop/start. A machine reboot does not auto-start
a stack. Native owner loss terminates exact process trees through a parent-death primitive or private
launcher pipe; container ingress fails closed until a current fenced session is established.

## Reconciliation and runtime execution

`StackReconciler` compares the accepted durable generation and materialized definition with an
observed workload snapshot, produces a deterministic plan from the in-memory execution graph, and
executes it through one runtime driver.

- Start follows dependency order; stop and destroy use reverse dependency order.
- A workload failure marks its capability failed and consumes its restart budget, while independent
  workloads continue. A dependency failure blocks dependent workloads and reports the dependency
  cause without stopping unrelated branches.
- Every readiness probe has a deadline. Catalog restart policy uses bounded exponential backoff,
  per-workload budgets, and a generation fence; exhausted workloads remain failed until explicit
  stop/restart.
- Durable running intent remains after caller failure and the Supervisor continues reconciliation.
- Process-tree termination and container removal target exact workload identity and generation.
- Lazy activation can prepare the dependency closure and start workloads once per generation; an
  activated capability remains active until stop/restart and is never evicted for idleness.

### Artifact preparation

`ArtifactStore` verifies native downloads and container images, publishes them atomically, and uses
Supervisor-local single-flight for identical transfers. Concurrent Supervisors may duplicate transfer
work safely; the design makes no cross-Supervisor or cross-identity deduplication promise. `prepare`
uses persisted pins or a validated prospective config, never reads or generates secrets, allocates
ports, creates networks, starts workloads, or changes durable state.

### Ports

```ts
type PortIntent =
  { readonly kind: "automatic" } | { readonly kind: "exact"; readonly port: number };

interface HostPortAssignment {
  readonly field: PortField;
  readonly port: number;
  readonly intent: "automatic" | "exact";
}
```

Automatic assignments are globally/logically exclusive while stacks are stopped or running. The
assignment is selected once and remains sticky. Exact assignments are persisted and sticky but do
not globally exclude another stopped stack; they conflict only with a live stack or host listener
when that stack starts. Under the registry lock, `PortCoordinator` retains unchanged assignments,
selects missing automatic ports, and validates exact requests. It commits the complete state before
releasing the lock and never performs downloads or runtime work in the transaction.

Native listeners remain bound and transfer directly to the in-process gateway. Container mode closes
its transient test socket before engine publication; the engine bind is authoritative. A host race
returns `PortUnavailableError` and retains the assignment without silently selecting another port.
Stop releases live sockets and publications but not logical records; destroy releases all records.

### Gateway and mandatory lazy activation

`StackGateway` is the only public ingress. HTTP owns routing, CORS, WebSockets, forwarding headers,
and error mapping. TCP copies bytes without interpreting PostgreSQL, TLS, SMTP, POP3, or STARTTLS.
Backend workloads use private network endpoints; only the gateway publishes host listeners.

Lazy activation is mandatory for both native and container runtimes. A native gateway invokes the
Supervisor activation capability in process. A container gateway uses a dedicated ephemeral exact-
release TCP `GatewayActivationServer` owned by the Supervisor, distinct from stable maintenance.

Before creating the gateway container, the Supervisor binds the activation server and writes an
owner-readable ephemeral file containing endpoint, random capability, `StackId`, desiredGeneration,
`gatewayInstanceId`, and `ownerSessionId`. The file is mounted read-only into the gateway; values are
never placed in labels or command arguments. The selected `ContainerEngine` adapter resolves the
host address/alias reachable from its gateway container: Docker Desktop uses
`host.docker.internal`, Linux Docker uses a host-gateway mapping, and Podman uses
`host.containers.internal` or its concrete equivalent. Unsupported engine/platform routing fails
before gateway creation.

The server validates every fence, bounds frame size, concurrent requests, and activation deadlines,
and grants activation only. It has no engine, artifact, filesystem, stop, destroy, configuration,
credential, or log authority. Capability files and server sockets rotate or are destroyed with the
owner and gateway. A request can activate only an enabled listener for the matching generation,
gateway instance, and owner session. Activation is one-way per generation; activated workloads use
catalog restart policy until stop/restart and are never idle-evicted. HTTP activation failure maps
to 503, post-activation backend failure to 502, and TCP activation failure closes the connection.

### Functions capability

Functions remain one public capability. Filesystem membership and content are live inputs; requests
are oneshot and no Supervisor watcher or desired-state mutation is involved. `functionsRoot` is the
sole allowed filesystem root and the sole container bind mount. It may resolve from `projectRoot`,
but every entrypoint, import map, static file, shared module, and symlink target must remain inside
that root. Per-function entrypoints are relative to their function directory; shared code belongs
inside the root (for example `_shared`). Traversal, absolute escapes, and symlink escapes are
rejected. Container mode mounts the whole root read-only at one stable private path.

On each request the Functions runtime resolves the slug, applies the persisted closed override, and
loads current entrypoint and module contents. Creating, editing, or deleting a function is visible on
the next request without a CLI call. A disabled override returns not found.

`supabase functions serve` always uses the managed stack Functions capability and Edge Runtime. It
creates or opens and starts the managed stack as needed, waits for Functions readiness, prints the
gateway URL, streams logs, and observes live edits. Incompatible persisted Functions settings fail
with an upgrade-required error and require explicit `supabase restart`. Caller exit closes only its
handle; the managed stack remains until an explicit stop or destroy.

## CLI boundaries

The CLI reloads `config.toml` and flags for each `supabase start`, translates `CliConfig` to
`StackConfig`, and calls:

```text
createStack({ projectRoot, name, runtime })
        │
        ├── optional stack.prepare({ config })
        └── stack.start({ config })
```

Editing `config.toml` alone has no effect. A changed running config is rejected; after `supabase
stop`, the next `supabase start` resolves and atomically persists the complete new definition.
`supabase restart` is the explicit owner replacement operation and may apply newly resolved config at
its fenced stop point. `supabase status` and watch output consume complete `StackStatus` snapshots.

The only workspace is `@supabase/stack`:

```text
packages/stack
├── public/             Effect API, Promise facade, public schemas
├── identity/           root, worktree, branch, and StackId resolution
├── model/              StackDefinition, compiler, capability modules, catalog
├── state/              atomic state, registry, ownership, ports, secret policy
├── supervisor/         Supervisor and StackReconciler
├── preparation/        verified ArtifactStore
├── runtime/            native and container drivers plus engine adapters
├── gateway/            HTTP, TCP, and activation server
├── control/            one owner endpoint, maintenance framing, exact-release RPC
└── entrypoints/        Supervisor and gateway executables
```

Only `@supabase/stack/effect`, the package-root Promise facade, testing helper, and shared public
types are exported. State, catalog, drivers, workload graph, control protocols, and gateway
internals remain private.

Expected operational failures are finite `Data.TaggedError` unions. Principal tags include:

- `InvalidStackIdentityError`, `InvalidProjectRootError`, `InvalidStackConfigError`;
- `StackNotFoundError`, `StackOwnershipConflictError`, `StackRuntimeMismatchError`;
- `StackDefinitionRequiredError`, `StackNotRunningError`, `StackMustBeStoppedError`,
  `StackLifecycleConflictError`;
- `StackStateInvalidError`, `StackStateFormatUnsupportedError`, `StackUpgradeRequiredError`,
  `StackUpgradeReplacementError`;
- `StackSecretMismatchError`, `InvalidJwtSigningMaterialError`;
- `PortAllocationError`, `PortUnavailableError`;
- `GatewayAuthenticationError`, `GatewayStaleGenerationError`, `GatewayActivationError`;
- `StackPreparationError`, `ArtifactIntegrityError`, `ContainerPullError`;
- `StackReconciliationError`, `ServiceStartError`, `ServiceReadinessError`,
  `ContainerEngineError`, `StackDestructionError`.

Operation-specific aliases expose only applicable tags. The Promise facade rejects with the same
tagged values and never collapses expected failures, interruption, or defects into a generic error.

## Construction sequence

Build observable vertical slices in this order:

1. Identity, durable materialized definition/fingerprint, one-owner endpoint, maintenance control,
   Supervisor launch, discovery, handle scopes, and caller-exit survival.
2. Native lifecycle: capability Modules, catalog/version validation, secrets, one representative
   workload graph, reconciliation, start, stop, explicit restart, destroy, status/watch, logs,
   credentials, and idempotent database bootstrap.
3. Ingress and preparation: sticky ports, native listener transfer, HTTP/TCP gateway,
   `GatewayActivationServer`, ArtifactStore, mandatory lazy activation, and live Functions.
4. Container execution and recovery: engine adapters, private networks, gateway-only publication,
   host-gateway aliases, activation-file fencing, workload-spec-hash adoption, and owner recovery.
5. Complete catalog: every capability's native/container mappings, platform/engine activation
   integration, port and secret matrices, and a small e2e smoke suite.
6. Promise facade and release: mechanical adaptation of the authoritative Effect contract,
   including plain-string credentials, explicit handle closure, `Option`, streams, and tagged
   failures.
7. Deferred final database-reset slice described below, after the runtime/catalog/Functions work is
   stable.

## Deferred final database-reset slice

The rewrite removes the single all-in-one database reset operation from the primary API. The caller
owns migrations, declarative schemas, seeds, progress, and their errors. Stack owns lifecycle
fencing, stopping database dependents, exact database-data recreation, internal idempotent bootstrap,
and preventing premature activation.

The eventual durable interface is a reset session, for example `beginDatabaseReset`, returning a
session with a database connection and explicit `complete`/`fail` operations. This API and its
persisted session shape are intentionally not frozen until this final slice. While a session exists,
the observable lifecycle is `resetting-database`, the ultimate desired lifecycle remains `running`,
and separate durable reset-session metadata fences dependents. Caller loss never silently resumes
dependents; a later caller may resume or initiate recovery. Migration history remains in the
database, not stack state.

This is the final behavioral slice of the rewrite, after the main runtime, catalog, and Functions
work. Its integration tests cover session fencing, exact data recreation, bootstrap ordering,
explicit completion/failure, caller loss, later resumption, and mechanical Promise adaptation.

## Testing strategy

Public integration scenarios are authoritative. Targeted unit tests are allowed for complex pure
configuration normalization, graph planning, transitions, restart decisions, and port planning.
Real subprocess, process-tree, ownership, filesystem, socket, and transport seams remain in
integration tests. Container lifecycle and lazy activation use controlled Docker/Podman engine
integration. Direct tests of a private boundary are added only when a concrete observability gap
cannot be covered through the public surface. A small e2e suite covers only critical CLI workflows.

### Public integration scenarios

Identity and handles:

- `createStack` does not read config or start workloads; `createTestStack` creates and cleans only
  its unique managed identity.
- Repeated calls, branches, detached worktrees, nested roots, and names produce documented ids.
- Discovery never creates or recovers a stack; two callers share one Supervisor.
- Closing an ordinary handle never stops the managed stack; only the unique test wrapper supports
  asynchronous disposal, and it destroys only its own test identity.
- Caller process exit leaves a running stack available to a second process.
- Runtime kind and engine are immutable; conflicting preferences fail.

Materialized configuration and lifecycle:

- First start persists a complete defaulted non-secret `StackDefinition`, `inputFingerprint`, and
  separately generated secret values without requiring a caller-supplied secret.
- Identical fingerprints reuse the exact definition across catalog/default changes.
- Any changed running fingerprint fails, even when the candidate definition would compare equal.
- Stopped changes resolve current defaults and persist definition/fingerprint atomically while
  retaining sticky versions, managed secrets, runtime, and unchanged ports; pass-through-only secret
  changes are detected independently of the non-secret fingerprint.
- A compatible identical running `start` returns the current status; changed input fails and
  incompatible ownership requires explicit restart.
- Restart fences/quiesces the old owner, preserves identity/data/runtime and unchanged sticky
  values, applies only allowed explicit stopped-time changes, and loses to an explicitly concurrent
  stop.
- Stop removes ephemeral resources but retains state/data/logs/artifacts; destroy removes exact data.
- Complete status snapshots start every watch subscription; logs use opaque cursors and atomic
  retained-to-live handoff.

Capabilities, workloads, and versions:

- Every one of the ten capability Modules validates its exhaustive settings schema and compiles
  native/container workload mappings.
- Independent workload failure does not stop unrelated branches; dependency failure blocks only
  dependents; readiness deadlines and restart budgets are observable.
- Exact unsupported versions fail before mutation; database version is immutable after initialization.
- Artifact preparation is atomic and Supervisor-local single-flight without a cross-Supervisor
  deduplication promise.
- Native and container stacks never mix workloads; concrete artifact keys remain private.

Secrets, logs, and ports:

- Managed secrets are unique, sticky, and mismatch-protected; pass-through secrets change only while
  stopped. Effect uses `Redacted`; Promise credentials are plain strings.
- Logs redact known exact secret strings, never emit full env/secret files or arguments, remain
  owner-only and bounded, and expose cursor continuity.
- Automatic port assignments remain globally/logically exclusive while stopped and running. Stopped
  exact assignments may coexist and conflict only with a live stack or host listener at start.
- Native listener transfer avoids a rebind window; container bind races preserve the sticky claim.

Gateway, activation, and Functions:

- HTTP/TCP routing, WebSockets, TLS, STARTTLS, backpressure, half-close, and 503/502 mapping work
  through the gateway.
- The ephemeral `GatewayActivationServer` uses the read-only fenced file, engine-specific host alias,
  bounded frames/concurrency/deadlines, exact-release protocol, and activation-only authority.
- Lazy activation is one-way per generation, honors dependency readiness and restart policy, and has
  no idle eviction. Health/status probes never activate a dormant capability.
- Function root traversal and symlink escapes are rejected; live create/edit/delete and shared
  modules are visible on the next oneshot request in native and container modes.
- `supabase functions serve` uses the managed stack, waits for readiness, streams logs, observes
  edits, requires explicit restart for incompatible persisted settings, and closes only its handle.

Recovery and deferred reset (final slice, after the initial suite):

- Corrupt state fails closed beside exact remnants; destructive recovery is explicit and identity-
  scoped.
- Native owner loss terminates exact process trees; containers fail closed until recovery. Adoption
  requires identity, generation, and workload-spec hash; stale/foreign resources are untouched.
- Machine reboot does not auto-start stacks; caller failure leaves durable running intent.
- Final reset-session tests are added only after the main runtime/catalog/Functions suite and cover
  dependent fencing, exact data recreation, bootstrap, explicit completion/failure, caller loss,
  later resumption, and Promise adaptation.

The Effect API is the behavioral test surface. Promise tests cover only mechanical adaptation and
handle ownership. Tests synchronize on readiness, events, control connections, files, or process
exit; they do not use arbitrary sleeps, released-port reuse, global process scans, or broad cleanup.
