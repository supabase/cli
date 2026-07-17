# Fleet

Host-level manager for running many isolated local Supabase stacks. Fleet adds copy-on-write data
templates, stable wake proxies, whole-stack scale-to-zero, idle suspension, reset, and fork on top
of the direct Stack runtime. It is exported from `@supabase/stack/fleet` and is designed to run
inside a long-lived host such as the Supabase CLI daemon.

Use `createStack()` for ordinary programmatic and parallel integration tests. Use Fleet when named
pods need stable endpoints while suspended, when environments need cheap reset/fork operations, or
when a long-lived host manages many more registered environments than it keeps warm.

## Quick start

```ts
import { createClient } from "@supabase/supabase-js";
import { createFleet } from "@supabase/stack/fleet";

await using fleet = await createFleet();
const pod = await fleet.createPod();

const supabase = createClient(pod.url, pod.publishableKey);
const { data } = await supabase.from("todos").select();
```

`createPod()` returns a ready pod by default. Postgres and the stack-owned gateway are running;
sidecars are prepared and started lazily by the inner Stack on first HTTP or Realtime WebSocket
request. Every pod gets stable database and API endpoints that survive Fleet suspend/wake cycles.

`createFleet()` owns its root exclusively and remains attached to the calling process. It does not
discover or launch a global daemon. A CLI daemon can host one Fleet and expose a remote control
interface to other processes without making that indirection part of `createStack()`.

## Tests

Prefer one directly owned `createStack()` per test worker or suite. Stack already provides
cross-process port leases, isolated temporary data directories, lazy sidecars, and strict cleanup,
so it is the simplest interface for many genuinely concurrent warm stacks.

Fleet is useful in tests with a different shape:

- hundreds of registered environments but only a small warm working set;
- repeated reset or copy-on-write fork from an expensive database fixture;
- external subprocesses that need endpoints to remain stable across suspend/wake;
- density, lifecycle, or CLI-daemon integration tests for Fleet itself.

Do not create a Fleet per parallel test worker against the same root. Fleet intentionally has one
owner per root; cross-process consumers should talk to a single daemon-hosted Fleet instead.

## Explicit services

All sidecars are available lazily by default. Use `services` to select an exact set; there are no
presets.

```ts
const pod = await fleet.createPod({
  id: "checkout-tests",
  services: ["postgrest", "auth", "realtime"],
});
```

Set `start: false` to register a suspended pod without launching its Stack. The first database,
HTTP, or WebSocket connection wakes it transparently:

```ts
const pod = await fleet.createPod({ start: false });
```

## API

```ts
interface CreatePodOptions {
  readonly id?: string; // random UUID by default
  readonly services?: ReadonlyArray<ProvisionedServiceName>; // all by default
  readonly versions?: Partial<VersionManifest>;
  readonly warmTemplate?: boolean; // true by default
  readonly start?: boolean; // true by default
  readonly projectDir?: string;
  readonly functions?: FunctionsConfig | false;
}

interface FleetHandle extends AsyncDisposable {
  createPod(opts?: CreatePodOptions): Promise<PodStatus>;
  destroyPod(id: string): Promise<void>;
  resetPod(id: string): Promise<void>;
  forkPod(sourceId: string, newId: string): Promise<PodStatus>;
  wake(id: string): Promise<void>;
  suspend(id: string): Promise<void>;
  ensureExtensionPreload(id: string, extension: string): Promise<void>;
  listPods(): Promise<ReadonlyArray<PodStatus>>;
  dispose(): Promise<void>;
}
```

`PodStatus` includes `id`, `state`, `url`, `dbUrl`, `publishableKey`, and `secretKey`. State is one
of `suspended`, `waking`, `warm`, or `suspending`.

## Ownership boundary

- Stack owns one warm Supabase runtime: Postgres, the API gateway, lazy asset preparation,
  dependency activation, HTTP routing, Realtime WebSockets, service lifecycle, and strict cleanup.
- Fleet owns many Stack runtimes: durable manifests, race-safe public port allocation, copy-on-write
  templates, wake deduplication, stable outer TCP proxies, idle suspension, reset, and fork.

The outer proxy never needs to understand Supabase routes. It wakes the pod and forwards the raw
database or API connection to the inner Stack, which remains the single owner of service-level
behavior.

## Lifecycle

- `createPod()` clones a service/version-specific warm template by default and starts only the
  minimal Stack runtime.
- `suspend()` disposes the inner Stack and verifies that the Postgres process group is gone while
  keeping the two public listeners bound.
- A connection to either listener deduplicates concurrent wake attempts, creates a new inner Stack,
  and forwards buffered bytes after it is ready.
- Pods with no open connections suspend after `idleMs` (five minutes by default).
- `forkPod()` takes an offline copy-on-write snapshot and restores the source's prior warm state.

## Current constraints

- Fleet provisioned pods use native Postgres on macOS and Linux; Docker-only sidecars can still be
  launched lazily by the inner Stack.
- Daemon restart reconciliation is kill-then-suspend rather than live process adoption. Stale
  Postgres process groups are reaped and the next connection wakes a fresh Stack against the same
  disposable data directory.
- Warm-template garbage collection and compatibility/benchmark suites remain future work.

See [the design specification](../../docs/specs/2026-07-07-micro-supabase-stacks-design.md) for
additional context.
