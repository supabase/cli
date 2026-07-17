# @supabase/fleet

Host-level daemon for running many lightweight Supabase pods in parallel:
CoW template provisioning, wake-on-connect, suspend-on-idle, instant fork.

## Quick start

```ts
import { createFleet } from "@supabase/fleet";

await using fleet = await createFleet();
const pod = await fleet.createPod({ id: "my-worktree", postgresVersion: "17.6.1.143" });
// pod.dbUrl is live immediately -- the first connection wakes postgres (~200ms).
// After 5 idle minutes (default) the pod suspends to zero processes; the port keeps listening.
const branch = await fleet.forkPod("my-worktree", "my-worktree-experiment");
```

## How it works

- `createPod` clones a per-Postgres-version template data directory (copy-on-write) and
  registers the pod's external `dbPort` on an in-process edge proxy. No Postgres process
  exists yet -- the pod starts `"suspended"`.
- The first connection to `dbPort` transparently wakes the pod (`"waking"` -> `"warm"`): the
  proxy spins up an in-process `@supabase/stack` handle against the pod's data directory and
  forwards the connection once Postgres is ready.
- A warm pod with no open connections for `idleMs` (default 5 minutes) suspends itself back to
  zero processes (`"warm"` -> `"suspending"` -> `"suspended"`); the port keeps listening for the
  next wake.
- `forkPod` suspends the source pod (if warm) and CoW-clones its data directory into a new pod
  with its own external port, so the two diverge independently from that point on.
- `wake` / `suspend` let a caller force the transition explicitly instead of waiting on
  connection activity or the idle timer.

## API

```ts
interface FleetOptions {
  readonly root?: string; // defaults to ~/.supabase
  readonly idleMs?: number; // defaults to 5 minutes
}

interface FleetHandle extends AsyncDisposable {
  createPod(opts: CreatePodOptions): Promise<PodStatus>;
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

`PodStatus.state` is one of `"suspended" | "waking" | "warm" | "suspending"`. `PodStatus.dbUrl` is
stable across suspend/wake cycles -- the external port never changes for the life of the pod.

## Phase 1 limitations

- **Native macOS/Linux only.** No Docker-mode fallback for fleet pods yet.
- **Kill-then-resuspend reconciliation, not adoption.** If the daemon restarts while pods are
  warm, it does not reattach to their running processes. Instead it reaps each pod's stale
  `postmaster.pid` (killing the leftover Postgres process group) and leaves the pod suspended;
  the next connection re-wakes it normally. Pod data is disposable, so this is safe, just not
  zero-downtime.
- **HTTP gateway / additional services are not fleet-wired yet.** The public fleet interface
  creates Postgres-only pods. Lazy sidecar startup remains available in `@supabase/stack`, but
  fleet will not expose sidecar selection until it owns a stable HTTP edge endpoint.
- **Realtime's WebSocket lazy-start is not covered.** Even inside a warm pod, Realtime's
  lazy-start behavior over a persistent WebSocket connection is a known gap versus the
  request/response lazy-start story for other HTTP services.

## Design

See [`docs/specs/2026-07-07-micro-supabase-stacks-design.md`](../../docs/specs/2026-07-07-micro-supabase-stacks-design.md) for the full design.

## Deferred to later phases

- Binary/Docker image optimizations.
- CLI wiring of `supabase start`/`stop` onto `createFleet`.
- HTTP gateway host-based routing across pods, plus edge wake for the API port.
- PSS/CPU benchmark harness with budget assertions in CI.
- True pod adoption across fleet-daemon restarts.
- Warm-template LRU garbage collection.
- `supautils` profile flag enforcement (the manifest field exists; config plumbing comes later).
- Compatibility suite (`CREATE EXTENSION` sweep, dump/restore round-trip).
