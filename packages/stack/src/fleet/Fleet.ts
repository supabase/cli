import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_VERSIONS,
  STACK_SERVICE_NAMES,
  postgresConnectionUrl,
  resolvePostgresPassword,
  type FunctionsConfig,
  type StackHandle,
  type VersionManifest,
} from "@supabase/stack";
import {
  configureExtensionPreload,
  createProvisionedStack,
  type ProvisionedServiceName,
} from "@supabase/stack/provisioned";
import { EdgeProxy } from "./EdgeProxy.ts";
import { acquireFleetLock } from "./fleetLock.ts";
import { IdleMonitor } from "./IdleMonitor.ts";
import type { PodManifest } from "./PodManifest.ts";
import { PodLock } from "./podLock.ts";
import { PodRegistry } from "./PodRegistry.ts";
import { PortRegistry } from "./PortRegistry.ts";
import { Provisioner } from "./Provisioner.ts";
import { reapStalePostmaster } from "./reapStalePostmaster.ts";
import { TemplateStore } from "./TemplateStore.ts";

export interface FleetOptions {
  readonly root?: string;
  readonly idleMs?: number;
}

export interface CreatePodOptions {
  readonly id?: string;
  readonly services?: ReadonlyArray<ProvisionedServiceName>;
  readonly versions?: Partial<VersionManifest>;
  /** Pre-migrate enabled services into the cached template. Default: true. */
  readonly warmTemplate?: boolean;
  /** Start Postgres before returning. Other enabled services stay lazy. Default: true. */
  readonly start?: boolean;
  readonly projectDir?: string;
  readonly functions?: FunctionsConfig | false;
}

export type PodState = "suspended" | "waking" | "warm" | "suspending";

export interface PodStatus {
  readonly id: string;
  readonly state: PodState;
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
}

export interface FleetHandle extends AsyncDisposable {
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

interface WarmPod {
  readonly stack: StackHandle;
  readonly internalDbPort: number;
  readonly internalApiPort: number;
}

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
 * - Startup reconciliation keys off postgres's own
 *   `<dataDir>/postmaster.pid` (see `reapStalePostmaster.ts`) since
 *   process-compose/`createStack` spawn postgres `detached: true` — its own
 *   process group, not the daemon's — so killing `-daemonPid` would miss it
 *   entirely. Reaping the postmaster's process group is the final verification
 *   after Stack performs strict cleanup of every service it owns. This is a
 *   kill-then-suspend policy, not adoption: the long-term goal is to
 *   adopt still-live pods across daemon restarts, but that requires
 *   reattaching the in-process StackHandle to an externally running set of
 *   processes, which isn't supported yet. Killing and letting the next
 *   connection re-wake the pod is acceptable because pod data is disposable
 *   and wake is fast.
 */
export async function createFleet(opts: FleetOptions = {}): Promise<FleetHandle> {
  const root = opts.root ?? join(homedir(), ".supabase");
  const idleMs = opts.idleMs ?? 5 * 60_000;
  // Must match packages/stack/src/services/postgres.ts: the template build stores
  // this password in the data dir, and pod connection URLs need to use the same
  // value when exposing the suspended/warm pod.
  const postgresPassword = resolvePostgresPassword();

  // Single daemon per root, acquired BEFORE any pod state is touched: the
  // startup reconciliation below kills postmasters it finds under pod dirs,
  // which would include a live sibling daemon's warm pods.
  const fleetLock = await acquireFleetLock(join(root, "fleet.lock"));

  const templates = new TemplateStore(join(root, "templates"), postgresPassword);
  const pods = new PodRegistry(join(root, "pods"));
  let ports: PortRegistry;
  try {
    ports = await PortRegistry.load(join(root, "fleet-state.json"));
  } catch (error) {
    const release = await Promise.allSettled([fleetLock.release()]);
    throwWithCleanup(error, release, "Failed to initialize and release Fleet lock");
  }
  const provisioner = new Provisioner({ templates, pods, ports, postgresPassword });

  const states = new Map<string, PodState>();
  const warm = new Map<string, WarmPod>();
  const wakesInFlight = new Map<string, Promise<WarmPod>>();
  const operationsInFlight = new Set<Promise<unknown>>();
  const podLocks = new PodLock();
  let disposed = false;
  let disposeInFlight: Promise<void> | undefined;

  function throwWithCleanup(
    primary: unknown,
    results: ReadonlyArray<PromiseSettledResult<unknown>>,
    message: string,
  ): never {
    const cleanupErrors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupErrors.length === 0) throw primary;
    throw new AggregateError([primary, ...cleanupErrors], message);
  }

  function assertCleanup(
    results: ReadonlyArray<PromiseSettledResult<unknown>>,
    message: string,
  ): void {
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, message);
  }

  function runOperation<T>(body: () => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new Error("fleet is disposed"));
    let operation: Promise<T>;
    try {
      operation = Promise.resolve(body());
    } catch (error) {
      operation = Promise.reject(error);
    }
    operationsInFlight.add(operation);
    void operation.then(
      () => operationsInFlight.delete(operation),
      () => operationsInFlight.delete(operation),
    );
    return operation;
  }

  const monitor = new IdleMonitor({
    idleMs,
    onIdle: (podId) => {
      void runOperation(() => idleSuspend(podId)).catch(() => {});
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
      password: manifest.postgresPassword,
      host: "127.0.0.1",
      port: manifest.dbPort,
      database: "postgres",
    });

  async function withPodLocks<T>(ids: ReadonlyArray<string>, body: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const acquire = (index: number): Promise<T> =>
      index >= ordered.length
        ? body()
        : podLocks.withLock(ordered[index]!, () => acquire(index + 1));
    return acquire(0);
  }

  async function rollbackProvisionedPod(id: string): Promise<void> {
    const results = await Promise.allSettled([proxy.unregister(id), provisioner.destroy(id)]);
    states.delete(id);
    assertCleanup(results, `Failed to roll back pod ${id}`);
  }

  /** Starts a pod while its lifecycle lock is already held. */
  async function wakeUpstreamLocked(id: string): Promise<WarmPod> {
    const lockedExisting = warm.get(id);
    if (lockedExisting !== undefined) {
      if (states.get(id) === "warm") {
        return lockedExisting;
      }
      throw new Error(`pod ${id} has not finished suspending; retry the suspend operation`);
    }
    const manifest = await pods.read(id);
    if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
    states.set(id, "waking");
    let stack: StackHandle | undefined;
    let internalDbPort = 0;
    let internalApiPort = 0;
    try {
      stack = await createProvisionedStack({
        stackRoot: join(pods.podDir(id), "stack"),
        dataDir: pods.dataDir(id),
        postgresPassword: manifest.postgresPassword,
        jwtSecret: manifest.jwtSecret,
        publishableKey: manifest.publishableKey,
        secretKey: manifest.secretKey,
        versions: manifest.versions,
        services: manifest.services,
        projectDir: manifest.projectDir ?? pods.podDir(id),
        functions: manifest.functions,
      });
      internalDbPort = Number(new URL(stack.dbUrl).port);
      internalApiPort = Number(new URL(stack.url).port);
      if (!Number.isInteger(internalDbPort) || internalDbPort <= 0) {
        throw new Error(`stack returned an invalid database URL for pod ${id}: ${stack.dbUrl}`);
      }
      if (!Number.isInteger(internalApiPort) || internalApiPort <= 0) {
        throw new Error(`stack returned an invalid API URL for pod ${id}: ${stack.url}`);
      }
      const pod = { stack, internalDbPort, internalApiPort };
      warm.set(id, pod);
      states.set(id, "warm");
      monitor.track(id);
      monitor.recordActivity(id, proxy.openConnections(id));
      return pod;
    } catch (err) {
      const cleanup = await Promise.allSettled(stack === undefined ? [] : [stack.dispose()]);
      if (cleanup.some((result) => result.status === "rejected") && stack !== undefined) {
        // Preserve the failed runtime so an explicit suspend/dispose can retry strict cleanup.
        warm.set(id, { stack, internalDbPort, internalApiPort });
        states.set(id, "suspending");
        throwWithCleanup(err, cleanup, `Failed to wake and clean up pod ${id}`);
      }
      states.set(id, "suspended");
      throw err;
    }
  }

  async function wakeUpstream(id: string): Promise<WarmPod> {
    if (disposed) throw new Error("fleet is disposed");
    const existing = warm.get(id);
    if (existing && states.get(id) === "warm") {
      return existing;
    }
    // Dedup deliberately stays OUTSIDE podLocks: EdgeProxy may invoke wake()
    // once per connection, and every such caller should share the SAME wake
    // (and thus the same lock acquisition), not each queue up its own.
    const inFlight = wakesInFlight.get(id);
    if (inFlight) return inFlight;
    const p = podLocks.withLock(id, () => wakeUpstreamLocked(id));
    const tracked = p.finally(() => {
      wakesInFlight.delete(id);
    });
    wakesInFlight.set(id, tracked);
    return tracked;
  }

  async function registerEdge(manifest: PodManifest): Promise<void> {
    states.set(manifest.id, "suspended");
    try {
      await proxy.register(manifest.id, "database", manifest.dbPort, async () => {
        const pod = await wakeUpstream(manifest.id);
        return { host: "127.0.0.1", port: pod.internalDbPort };
      });
      await proxy.register(manifest.id, "api", manifest.apiPort, async () => {
        const pod = await wakeUpstream(manifest.id);
        return { host: "127.0.0.1", port: pod.internalApiPort };
      });
    } catch (error) {
      const cleanup = await Promise.allSettled([proxy.unregister(manifest.id)]);
      throwWithCleanup(error, cleanup, `Failed to register and roll back pod ${manifest.id}`);
    }
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

  // Idle-triggered suspend: unlike an explicit suspend, this must yield to
  // clients that connected between the idle timer firing (which untracks the
  // pod, making their recordActivity a no-op) and this body acquiring the pod
  // lock. Those connections were already accepted by the proxy — and any
  // connection accepted AFTER the openConnections check below can no longer
  // grab the warm upstream, because the check and `warm.delete` in
  // suspendLocked run in the same synchronous block.
  async function idleSuspend(id: string): Promise<void> {
    return podLocks.withLock(id, async () => {
      if (proxy.openConnections(id) > 0 && warm.has(id)) {
        monitor.track(id);
        monitor.recordActivity(id, proxy.openConnections(id));
        return;
      }
      await suspendLocked(id);
    });
  }

  async function suspendLocked(id: string): Promise<void> {
    const pod = warm.get(id);
    if (!pod) return;
    states.set(id, "suspending");
    monitor.untrack(id);
    await pod.stack.dispose();
    // StackHandle.dispose() is strict. Reaping the postmaster is an additional
    // fleet-level verification because a suspended pod must own no processes.
    await reapStalePostmaster(pods.dataDir(id));
    warm.delete(id);
    states.set(id, "suspended");
  }

  async function status(manifest: PodManifest): Promise<PodStatus> {
    return {
      id: manifest.id,
      state: states.get(manifest.id) ?? "suspended",
      url: `http://127.0.0.1:${manifest.apiPort}`,
      dbUrl: dbUrl(manifest),
      publishableKey: manifest.publishableKey,
      secretKey: manifest.secretKey,
    };
  }

  // Startup reconciliation uses kill-then-suspend, not adoption
  // (see class doc above). The kill decision keys off postgres's own ground
  // truth, `<dataDir>/postmaster.pid`, whose first
  // line is the postmaster's pid; the postmaster is always its own
  // process-group leader, so `reapStalePostmaster` can reliably signal the
  // whole tree via `-pid`. The pod port registry is reconciled
  // to exactly the valid manifests on disk so stale allocations from deleted
  // or skipped pods are pruned during startup.
  try {
    // Reap over EVERY pod directory on disk — not just parseable manifests. A
    // corrupt pod.json is exactly the case where the previous daemon may have
    // died uncleanly, and skipping it would leave its stale postmaster bound
    // to ports that the reconcile below is about to prune and hand out again.
    for (const id of await pods.listIds()) {
      await reapStalePostmaster(pods.dataDir(id));
    }
    const manifests = await pods.list();
    await ports.reconcile(
      new Map(
        manifests.map((manifest) => [
          manifest.id,
          { dbPort: manifest.dbPort, apiPort: manifest.apiPort },
        ]),
      ),
    );
    for (const manifest of manifests) {
      await registerEdge(manifest);
    }
  } catch (err) {
    const cleanup = await Promise.allSettled([proxy.close(), fleetLock.release()]);
    throwWithCleanup(err, cleanup, "Failed to initialize and clean up Fleet");
  }

  const handle: FleetHandle = {
    createPod(opts = {}) {
      const id = opts.id ?? randomUUID();
      return runOperation(() =>
        podLocks.withLock(id, async () => {
          const manifest = await provisioner.create({
            id,
            versions: { ...DEFAULT_VERSIONS, ...opts.versions },
            services: opts.services ?? STACK_SERVICE_NAMES,
            warm: opts.warmTemplate ?? true,
            projectDir: opts.projectDir,
            functions: opts.functions,
          });
          try {
            await registerEdge(manifest);
            if (opts.start !== false) {
              await wakeUpstreamLocked(manifest.id);
            }
            return status(manifest);
          } catch (err) {
            const cleanup = await Promise.allSettled([rollbackProvisionedPod(manifest.id)]);
            throwWithCleanup(err, cleanup, `Failed to create and roll back pod ${manifest.id}`);
          }
        }),
      );
    },
    destroyPod(id) {
      // suspend (tears down live processes) and provisioner.destroy (deletes
      // the data dir) run as ONE lock acquisition so a wake that's still
      // mid-flight (registered in wakesInFlight, not yet in `warm`) can't
      // slip in between them and recreate a stack against a dir we're about
      // to delete.
      return runOperation(() =>
        podLocks.withLock(id, async () => {
          await suspendLocked(id);
          await proxy.unregister(id);
          await provisioner.destroy(id);
          states.delete(id);
        }),
      );
    },
    resetPod(id) {
      return runOperation(() =>
        podLocks.withLock(id, async () => {
          const wasWarm = states.get(id) === "warm";
          await suspendLocked(id);
          await provisioner.reset(id);
          if (wasWarm) await wakeUpstreamLocked(id);
        }),
      );
    },
    forkPod(sourceId, newId) {
      // Lock the SOURCE pod around suspend + the fork's clone of its data
      // dir (provisioner.fork reads sourceId's data dir), and lock the TARGET
      // id so concurrent creates/forks cannot delete each other's results.
      return runOperation(async () => {
        if (sourceId === newId) throw new Error(`pod already exists: ${newId}`);
        const manifest = await withPodLocks([sourceId, newId], async () => {
          const sourceWasWarm = states.get(sourceId) === "warm";
          await suspendLocked(sourceId);
          const forked = await provisioner.fork(sourceId, newId);
          try {
            // Forking needs an offline snapshot, but it should not change the
            // source pod's observable lifecycle state after the clone is done.
            if (sourceWasWarm) await wakeUpstreamLocked(sourceId);
            await registerEdge(forked);
            await wakeUpstreamLocked(forked.id);
            return forked;
          } catch (err) {
            const cleanup = await Promise.allSettled([rollbackProvisionedPod(forked.id)]);
            throwWithCleanup(err, cleanup, `Failed to fork and roll back pod ${forked.id}`);
          }
        });
        return status(manifest);
      });
    },
    wake(id) {
      return runOperation(async () => {
        await wakeUpstream(id);
      });
    },
    suspend(id) {
      return runOperation(() => suspend(id));
    },
    // This configures preload state; it does not run CREATE EXTENSION. Preload-required
    // libraries are persisted and postgres is restarted when warm. Other
    // extensions require no orchestration and are therefore a no-op here.
    ensureExtensionPreload(id, extension) {
      return runOperation(() =>
        podLocks.withLock(id, async () => {
          const pod = warm.get(id);
          if (pod) {
            await pod.stack.ensureExtensionPreload(extension);
            return;
          }
          const manifest = await pods.read(id);
          if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
          await configureExtensionPreload(pods.dataDir(id), extension);
        }),
      );
    },
    listPods() {
      return runOperation(async () => {
        const manifests = await pods.list();
        return Promise.all(manifests.map((m) => status(m)));
      });
    },
    dispose() {
      if (disposeInFlight !== undefined) return disposeInFlight;
      disposed = true;
      const attempt = (async () => {
        const cleanupErrors: unknown[] = [];
        await Promise.allSettled(operationsInFlight);
        try {
          await proxy.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        await Promise.allSettled(wakesInFlight.values());
        const suspendResults = await Promise.allSettled(
          [...warm.keys()].map((id) => podLocks.withLock(id, () => suspendLocked(id))),
        );
        for (const result of suspendResults) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) {
          throw new AggregateError(cleanupErrors, "failed to dispose fleet cleanly");
        }
        // Releasing the root lock certifies that this daemon no longer owns
        // listeners or pod processes. Keep it held when cleanup fails so a
        // second daemon cannot reconcile the same root concurrently; callers
        // may retry dispose() after the transient failure is resolved.
        await fleetLock.release();
      })();
      disposeInFlight = attempt.catch((error: unknown) => {
        disposeInFlight = undefined;
        throw error;
      });
      return disposeInFlight;
    },
    async [Symbol.asyncDispose]() {
      await handle.dispose();
    },
  };
  return handle;
}
