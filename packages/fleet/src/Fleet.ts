import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createStack,
  PRELOAD_REQUIRED_EXTENSIONS,
  readPreloadLibraries,
  writePreloadLibraries,
  type StackHandle,
} from "@supabase/stack";
import { EdgeProxy, type PodUpstream } from "./EdgeProxy.ts";
import { IdleMonitor } from "./IdleMonitor.ts";
import type { PodManifest } from "./PodManifest.ts";
import { PodRegistry } from "./PodRegistry.ts";
import { PortRegistry } from "./PortRegistry.ts";
import { Provisioner, type CreatePodOptions } from "./Provisioner.ts";
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

// Matches the supabase CLI local-dev convention (see packages/stack
// services/postgres.ts POSTGRES_PASSWORD default) — a template-built
// postgres data dir only accepts this password.
const DB_PASSWORD = "postgres";

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
 * - `run.pid` files under each pod's directory record which daemon process
 *   currently owns a warm pod; startup reconciliation uses them to kill stale
 *   processes from a previous daemon run before treating every pod as
 *   suspended. This is a phase-1 kill-then-suspend policy, not adoption: the
 *   spec's long-term goal is to adopt still-live pods across daemon restarts,
 *   but that requires reattaching the in-process StackHandle to an externally
 *   running set of processes, which isn't supported yet. Killing and letting
 *   the next connection re-wake the pod is acceptable because pod data is
 *   disposable and wake is fast.
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
    `postgresql://postgres:${DB_PASSWORD}@127.0.0.1:${manifest.ports.dbPort}/postgres`;

  const runPidFile = (id: string): string => join(pods.podDir(id), "run.pid");

  async function wakeUpstream(id: string): Promise<PodUpstream> {
    const existing = warm.get(id);
    if (existing) return { host: "127.0.0.1", port: existing.internalDbPort };
    const inFlight = wakesInFlight.get(id);
    if (inFlight) return inFlight;
    const p = (async (): Promise<PodUpstream> => {
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
        postgrest: manifest.services.postgrest === true ? {} : false,
        auth: manifest.services.auth === true ? {} : false,
        realtime: manifest.services.realtime === true ? {} : false,
        edgeRuntime: manifest.services["edge-runtime"] === true ? {} : false,
        storage: manifest.services.storage === true ? {} : false,
        imgproxy: manifest.services.imgproxy === true ? {} : false,
        mailpit: manifest.services.mailpit === true ? {} : false,
        pgmeta: manifest.services.pgmeta === true ? {} : false,
        studio: manifest.services.studio === true ? {} : false,
        analytics: manifest.services.analytics === true ? {} : false,
        vector: manifest.services.vector === true ? {} : false,
        pooler: manifest.services.pooler === true ? {} : false,
        functions: false,
      });
      try {
        await stack.start();
        await stack.serviceReady("postgres");
      } catch (err) {
        await stack.dispose().catch(() => {});
        throw err;
      }
      warm.set(id, { stack, internalDbPort });
      states.set(id, "warm");
      monitor.track(id);
      monitor.recordActivity(id, proxy.openConnections(id));
      await writeFile(runPidFile(id), String(process.pid));
      return { host: "127.0.0.1", port: internalDbPort };
    })().catch((err: unknown) => {
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
  // (see class doc above). Any pod with a run.pid file left over from a
  // previous daemon has its process terminated before we treat it as
  // suspended; the pod's ports are also re-seeded into the freshly loaded
  // PortRegistry from its manifest, which is the mechanism `restore()` exists
  // for (recovering from a quarantined/corrupt port-state file).
  for (const manifest of await pods.list()) {
    await ports.restore(manifest.id, manifest.ports);

    const pidRaw = await readFile(runPidFile(manifest.id), "utf8").catch(() => undefined);
    if (pidRaw !== undefined) {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          /* not a process-group leader, or already gone */
        }
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, 5000).unref();
      }
      await rm(runPidFile(manifest.id), { force: true });
    }
    await registerEdge(manifest);
  }

  const handle: FleetHandle = {
    async createPod(opts) {
      const manifest = await provisioner.create(opts);
      await registerEdge(manifest);
      return status(manifest);
    },
    async destroyPod(id) {
      await suspend(id);
      await proxy.unregister(id);
      states.delete(id);
      await provisioner.destroy(id);
    },
    async resetPod(id) {
      await suspend(id);
      await provisioner.reset(id);
    },
    async forkPod(sourceId, newId) {
      await suspend(sourceId);
      const manifest = await provisioner.fork(sourceId, newId);
      await registerEdge(manifest);
      return status(manifest);
    },
    async wake(id) {
      await wakeUpstream(id);
    },
    suspend,
    async enableExtension(id, extension) {
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
    },
    async listPods() {
      const manifests = await pods.list();
      return Promise.all(manifests.map((m) => status(m)));
    },
    async dispose() {
      for (const id of warm.keys()) await suspend(id);
      await proxy.close();
    },
    async [Symbol.asyncDispose]() {
      await handle.dispose();
    },
  };
  return handle;
}
