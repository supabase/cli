import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createStack,
  postgresConnectionUrl,
  PRELOAD_REQUIRED_EXTENSIONS,
  readPreloadLibraries,
  resolvePostgresPassword,
  writePreloadLibraries,
  type StackHandle,
} from "@supabase/stack";
import { EdgeProxy, type PodUpstream } from "./EdgeProxy.ts";
import { IdleMonitor } from "./IdleMonitor.ts";
import type { PodManifest } from "./PodManifest.ts";
import { PodLock } from "./podLock.ts";
import { PodRegistry } from "./PodRegistry.ts";
import { PortRegistry } from "./PortRegistry.ts";
import { Provisioner, type CreatePodOptions } from "./Provisioner.ts";
import { reapStalePostmaster } from "./reapStalePostmaster.ts";
import { TemplateStore } from "./TemplateStore.ts";

export interface FleetOptions {
  readonly root?: string;
  readonly idleMs?: number;
}

export type PodState = "suspended" | "waking" | "warm" | "suspending";

export interface PodStatus {
  readonly manifest: PodManifest;
  readonly state: PodState;
  readonly dbUrl: string;
}

export interface FleetHandle extends AsyncDisposable {
  createPod(opts: CreatePodOptions): Promise<PodStatus>;
  destroyPod(id: string): Promise<void>;
  resetPod(id: string): Promise<void>;
  forkPod(sourceId: string, newId: string): Promise<PodStatus>;
  wake(id: string): Promise<void>;
  suspend(id: string): Promise<void>;
  enableExtension(id: string, extension: string): Promise<void>;
  listPods(): Promise<ReadonlyArray<PodStatus>>;
  dispose(): Promise<void>;
}

interface WarmPod {
  readonly stack: StackHandle;
  readonly internalDbPort: number;
}

// Must match packages/stack/src/services/postgres.ts: the template build stores
// this password in the data dir, and pod connection URLs need to use the same
// value when exposing the suspended/warm pod.
const DB_PASSWORD = resolvePostgresPassword();

// Internal (in-process stack) ports are derived from the externally-visible,
// PortRegistry-owned port by a fixed +10_000 offset so the two ranges never
// collide. PortRegistry hands out ports starting at 55_000, so this scheme
// only stays valid while every allocated external port is < 55_536; beyond
// that the derived internal port would exceed the 16-bit port ceiling
// (65_535). Fine for the pod counts this phase targets; a later phase should
// allocate internal ports dynamically (e.g. port 0) if the fleet needs to
// scale past that.
const INTERNAL_PORT_OFFSET = 10_000;

/**
 * Public facade tying together TemplateStore/PodRegistry/PortRegistry/Provisioner
 * (pod lifecycle + storage) with EdgeProxy/IdleMonitor (wake-on-connect,
 * suspend-on-idle) to host warm pods as in-process `@supabase/stack` StackHandles.
 *
 * - Every pod's external `dbPort` is registered on the EdgeProxy the moment the
 *   pod is known (created, forked, or discovered at startup) and never changes
 *   again; suspended pods still "answer" that port because the proxy itself
 *   owns the listener and defers to `wake()` on first connection.
 * - A pod's postgres process (and any other lazily-started stack services)
 *   only exists while the pod is "warm": `wakeUpstream` creates an in-process
 *   `StackHandle` on demand and tears it down again in `suspend`.
 * - Concurrent wakes of the same pod are deduped via `wakesInFlight`, since
 *   EdgeProxy may invoke `wake()` once per connection.
 * - Every operation that touches a pod's live processes or on-disk data dir
 *   (the body of a wake, the body of `suspend`, and the process/data-dir
 *   affecting parts of `destroyPod`/`resetPod`/`forkPod`) runs inside
 *   `podLocks.withLock(id, ...)`, a per-pod FIFO chain (see `podLock.ts`).
 *   This prevents e.g. a wake racing an in-flight suspend from calling
 *   `createStack` against a data dir whose postmaster is still shutting
 *   down, or `destroyPod`/`resetPod` deleting a data dir out from under a
 *   wake that's still in `wakesInFlight` (and thus not yet visible in
 *   `warm`). Wake dedup via `wakesInFlight` deliberately stays OUTSIDE the
 *   lock so concurrent connections still share a single wake; only the
 *   shared wake body itself acquires the lock.
 * - `run.pid` files under each pod's directory record which daemon process
 *   currently owns a warm pod; startup reconciliation uses them as a hint
 *   that the pod *may* have been running under a previous daemon. The
 *   actual kill decision, however, keys off postgres's own
 *   `<dataDir>/postmaster.pid` (see `reapStalePostmaster.ts`) since
 *   process-compose/`createStack` spawn postgres `detached: true` — its own
 *   process group, not the daemon's — so killing `-daemonPid` would miss it
 *   entirely. Phase 1 only ever runs postgres under a fleet pod (no HTTP
 *   edge yet), so reaping the postmaster's process group covers every
 *   process a stale pod could have left behind. This is a phase-1
 *   kill-then-suspend policy, not adoption: the spec's long-term goal is to
 *   adopt still-live pods across daemon restarts, but that requires
 *   reattaching the in-process StackHandle to an externally running set of
 *   processes, which isn't supported yet. Killing and letting the next
 *   connection re-wake the pod is acceptable because pod data is disposable
 *   and wake is fast.
 */
export async function createFleet(opts: FleetOptions = {}): Promise<FleetHandle> {
  const root = opts.root ?? join(homedir(), ".supabase");
  const idleMs = opts.idleMs ?? 5 * 60_000;

  const templates = new TemplateStore(join(root, "templates"));
  const pods = new PodRegistry(join(root, "pods"));
  const ports = await PortRegistry.load(join(root, "fleet-state.json"));
  const provisioner = new Provisioner({ templates, pods, ports });

  const states = new Map<string, PodState>();
  const warm = new Map<string, WarmPod>();
  const wakesInFlight = new Map<string, Promise<PodUpstream>>();
  const podLocks = new PodLock();
  let disposed = false;

  const monitor = new IdleMonitor({
    idleMs,
    onIdle: (podId) => {
      void suspend(podId).catch(() => {});
    },
  });

  const proxy = new EdgeProxy({
    onActivity: (podId, _event, openConnections) => {
      monitor.recordActivity(podId, openConnections);
    },
  });

  const dbUrl = (manifest: PodManifest): string =>
    postgresConnectionUrl({
      user: "postgres",
      password: DB_PASSWORD,
      host: "127.0.0.1",
      port: manifest.ports.dbPort,
      database: "postgres",
    });

  const runPidFile = (id: string): string => join(pods.podDir(id), "run.pid");

  async function withPodLocks<T>(ids: ReadonlyArray<string>, body: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const acquire = (index: number): Promise<T> =>
      index >= ordered.length
        ? body()
        : podLocks.withLock(ordered[index]!, () => acquire(index + 1));
    return acquire(0);
  }

  async function rollbackProvisionedPod(id: string): Promise<void> {
    await proxy.unregister(id).catch(() => {});
    await provisioner.destroy(id).catch(() => {});
    states.delete(id);
  }

  async function wakeUpstream(id: string): Promise<PodUpstream> {
    if (disposed) throw new Error("fleet is disposed");
    const existing = warm.get(id);
    if (existing) return { host: "127.0.0.1", port: existing.internalDbPort };
    // Dedup deliberately stays OUTSIDE podLocks: EdgeProxy may invoke wake()
    // once per connection, and every such caller should share the SAME wake
    // (and thus the same lock acquisition), not each queue up its own.
    const inFlight = wakesInFlight.get(id);
    if (inFlight) return inFlight;
    const p = podLocks
      .withLock(id, async (): Promise<PodUpstream> => {
        const manifest = await pods.read(id);
        if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
        states.set(id, "waking");
        const internalDbPort = manifest.ports.dbPort + INTERNAL_PORT_OFFSET;
        const stack = await createStack({
          stackRoot: join(pods.podDir(id), "stack"),
          port: manifest.ports.apiPort + INTERNAL_PORT_OFFSET,
          lazyServices: true,
          postgres: {
            dataDir: pods.dataDir(id),
            version: manifest.versions.postgres,
            port: internalDbPort,
            provisioned: true,
            profile: "micro",
          },
          postgrest:
            manifest.services.postgrest === true ? { version: manifest.versions.postgrest } : false,
          auth: manifest.services.auth === true ? { version: manifest.versions.auth } : false,
          realtime:
            manifest.services.realtime === true ? { version: manifest.versions.realtime } : false,
          edgeRuntime:
            manifest.services["edge-runtime"] === true
              ? { version: manifest.versions["edge-runtime"] }
              : false,
          storage:
            manifest.services.storage === true ? { version: manifest.versions.storage } : false,
          imgproxy:
            manifest.services.imgproxy === true ? { version: manifest.versions.imgproxy } : false,
          mailpit:
            manifest.services.mailpit === true ? { version: manifest.versions.mailpit } : false,
          pgmeta: manifest.services.pgmeta === true ? { version: manifest.versions.pgmeta } : false,
          studio: manifest.services.studio === true ? { version: manifest.versions.studio } : false,
          analytics:
            manifest.services.analytics === true ? { version: manifest.versions.analytics } : false,
          vector: manifest.services.vector === true ? { version: manifest.versions.vector } : false,
          pooler: manifest.services.pooler === true ? { version: manifest.versions.pooler } : false,
          functions: false,
        });
        try {
          await stack.start();
          await stack.serviceReady("postgres");
          await writeFile(runPidFile(id), String(process.pid));
          warm.set(id, { stack, internalDbPort });
          states.set(id, "warm");
          monitor.track(id);
          monitor.recordActivity(id, proxy.openConnections(id));
          return { host: "127.0.0.1", port: internalDbPort };
        } catch (err) {
          await stack.dispose().catch(() => {});
          throw err;
        }
      })
      .catch((err: unknown) => {
        states.set(id, "suspended");
        throw err;
      });
    const tracked = p.finally(() => {
      wakesInFlight.delete(id);
    });
    wakesInFlight.set(id, tracked);
    return tracked;
  }

  async function registerEdge(manifest: PodManifest): Promise<void> {
    states.set(manifest.id, "suspended");
    await proxy.register(manifest.id, manifest.ports.dbPort, () => wakeUpstream(manifest.id));
  }

  async function suspend(id: string): Promise<void> {
    // Full body runs inside the per-pod lock so a suspend can never
    // interleave with a concurrent wake, destroy, reset, or fork touching
    // the same pod's process/data dir. Note this is a fresh, non-re-entrant
    // acquisition: callers that already hold the lock for `id` (forkPod's
    // source-pod lock) call the LOCKED body directly instead of this
    // function — see `suspendLocked` usage below.
    return podLocks.withLock(id, () => suspendLocked(id));
  }

  async function suspendLocked(id: string): Promise<void> {
    const pod = warm.get(id);
    if (!pod) return;
    states.set(id, "suspending");
    monitor.untrack(id);
    warm.delete(id);
    await pod.stack.dispose();
    await rm(runPidFile(id), { force: true });
    states.set(id, "suspended");
  }

  async function status(manifest: PodManifest): Promise<PodStatus> {
    return {
      manifest,
      state: states.get(manifest.id) ?? "suspended",
      dbUrl: dbUrl(manifest),
    };
  }

  // Startup reconciliation: phase 1 policy is kill-then-suspend, not adoption
  // (see class doc above). `run.pid` (the daemon's own pid) is only a HINT
  // that a pod may have been running under a previous daemon; it's not the
  // kill target, since process-compose/createStack spawn postgres
  // `detached: true` — its own process group, distinct from the daemon's —
  // so `kill(-daemonPid, ...)` would miss postgres entirely and leave a
  // stale postmaster running forever. The actual kill decision keys off
  // postgres's own ground truth, `<dataDir>/postmaster.pid`, whose first
  // line is the postmaster's pid; the postmaster is always its own
  // process-group leader, so `reapStalePostmaster` can reliably signal the
  // whole tree via `-pid`. Phase 1 only ever runs postgres under a fleet pod
  // (postgres-only ready gate; no HTTP edge yet), so this fully covers what
  // a stale pod could have left behind. The pod's ports are also re-seeded
  // into the freshly loaded PortRegistry from its manifest, which is the
  // mechanism `restore()` exists for (recovering from a quarantined/corrupt
  // port-state file).
  try {
    for (const manifest of await pods.list()) {
      await ports.restore(manifest.id, manifest.ports);
      await reapStalePostmaster(pods.dataDir(manifest.id));
      await rm(runPidFile(manifest.id), { force: true });
      await registerEdge(manifest);
    }
  } catch (err) {
    await proxy.close().catch(() => {});
    throw err;
  }

  const handle: FleetHandle = {
    async createPod(opts) {
      return podLocks.withLock(opts.id, async () => {
        const manifest = await provisioner.create(opts);
        try {
          await registerEdge(manifest);
          return status(manifest);
        } catch (err) {
          await rollbackProvisionedPod(manifest.id);
          throw err;
        }
      });
    },
    async destroyPod(id) {
      // suspend (tears down live processes) and provisioner.destroy (deletes
      // the data dir) run as ONE lock acquisition so a wake that's still
      // mid-flight (registered in wakesInFlight, not yet in `warm`) can't
      // slip in between them and recreate a stack against a dir we're about
      // to delete.
      await podLocks.withLock(id, async () => {
        await suspendLocked(id);
        await proxy.unregister(id);
        await provisioner.destroy(id);
        states.delete(id);
      });
    },
    async resetPod(id) {
      await podLocks.withLock(id, async () => {
        await suspendLocked(id);
        await provisioner.reset(id);
      });
    },
    async forkPod(sourceId, newId) {
      if (sourceId === newId) throw new Error(`pod already exists: ${newId}`);
      // Lock the SOURCE pod around suspend + the fork's clone of its data
      // dir (provisioner.fork reads sourceId's data dir), and lock the TARGET
      // id so concurrent creates/forks cannot delete each other's results.
      const manifest = await withPodLocks([sourceId, newId], async () => {
        await suspendLocked(sourceId);
        const forked = await provisioner.fork(sourceId, newId);
        try {
          await registerEdge(forked);
          return forked;
        } catch (err) {
          await rollbackProvisionedPod(forked.id);
          throw err;
        }
      });
      return status(manifest);
    },
    async wake(id) {
      await wakeUpstream(id);
    },
    suspend,
    // Preload-only semantics when suspended: if the pod is warm, this
    // enables `extension` immediately via the live StackHandle (CREATE
    // EXTENSION, possibly after a preload-triggered restart) regardless of
    // which extension it is. If the pod is SUSPENDED, there is no live
    // postgres to run CREATE EXTENSION against, so this can only durably
    // record intent for extensions that need a preload library — those get
    // appended to the data dir's preload-libraries config so the next wake
    // picks them up. For a suspended pod and a NON-preload extension (i.e.
    // not in `PRELOAD_REQUIRED_EXTENSIONS`), this method is a silent no-op:
    // nothing is persisted, and the extension is NOT created on the next
    // wake. Callers that need a non-preload extension enabled on a
    // currently-suspended pod must `wake()` it first.
    async enableExtension(id, extension) {
      await podLocks.withLock(id, async () => {
        const pod = warm.get(id);
        if (pod) {
          await pod.stack.enableExtension(extension);
          return;
        }
        const manifest = await pods.read(id);
        if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
        if (!PRELOAD_REQUIRED_EXTENSIONS.has(extension)) return;
        const libs = await readPreloadLibraries(pods.dataDir(id));
        if (!libs.includes(extension)) {
          await writePreloadLibraries(pods.dataDir(id), [...libs, extension]);
        }
      });
    },
    async listPods() {
      const manifests = await pods.list();
      return Promise.all(manifests.map((m) => status(m)));
    },
    async dispose() {
      disposed = true;
      await proxy.close();
      await Promise.allSettled(wakesInFlight.values());
      for (const id of warm.keys()) await suspend(id);
    },
    async [Symbol.asyncDispose]() {
      await handle.dispose();
    },
  };
  return handle;
}
