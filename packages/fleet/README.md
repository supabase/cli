# @supabase/fleet

Host-level daemon for running many isolated local Supabase stacks. Fleet adds copy-on-write data
templates, stable wake proxies, whole-stack scale-to-zero, idle suspension, reset, and fork on top
of `@supabase/stack`.

Use `@supabase/stack` for ordinary programmatic integration tests. Use Fleet when pods need stable
endpoints while suspended or when a long-lived host manages many test environments.

## Quick start

```ts
import { createClient } from "@supabase/supabase-js";
import { createFleet } from "@supabase/fleet";

await using fleet = await createFleet();
const pod = await fleet.createPod();

const supabase = createClient(pod.url, pod.publishableKey);
const { data } = await supabase.from("todos").select();
```

`createPod()` returns a ready pod by default. Postgres and the stack-owned gateway are running;
sidecars are prepared and started lazily by the inner Stack on first HTTP or Realtime WebSocket
request. Every pod gets stable database and API endpoints that survive Fleet suspend/wake cycles.

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
