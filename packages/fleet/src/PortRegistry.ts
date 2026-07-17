import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

export interface PodEndpoint {
  readonly dbPort: number;
}

interface PortState {
  readonly pods: Record<string, PodEndpoint>;
}

const DEFAULT_BASE_PORT = 55_000;
const MAX_PORT = 65_535;

/** Proxy-owned listeners bind here; persisted pod endpoints must stay in this range. */
export const FLEET_PUBLIC_PORT_RANGE = { min: DEFAULT_BASE_PORT, max: MAX_PORT } as const;

function freshState(): PortState {
  return { pods: {} };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFleetPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FLEET_PUBLIC_PORT_RANGE.min &&
    value <= FLEET_PUBLIC_PORT_RANGE.max
  );
}

function isPodEndpoint(value: unknown): value is PodEndpoint {
  return isRecord(value) && isFleetPort(value.dbPort);
}

function isValidState(value: unknown): value is PortState {
  if (!isRecord(value) || !isRecord(value.pods)) return false;
  const used = new Set<number>();
  for (const endpoint of Object.values(value.pods)) {
    if (!isPodEndpoint(endpoint) || used.has(endpoint.dbPort)) return false;
    used.add(endpoint.dbPort);
  }
  return true;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

/**
 * Persistent registry for the only durable phase-1 endpoint: the database
 * port held open by EdgeProxy for the pod's entire lifetime. Internal stack
 * ports belong to a warm runtime and are allocated by @supabase/stack on each
 * wake, so they are intentionally absent from this state.
 *
 * Mutations are serialized in-process; the fleet-root lock provides the
 * cross-process single-owner guarantee. New allocations probe the host before
 * persisting so an unrelated listener does not permanently poison the first
 * candidate in the fleet range.
 */
export class PortRegistry {
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly stateFile: string,
    private state: PortState,
  ) {}

  static async load(stateFile: string): Promise<PortRegistry> {
    const raw = await readFile(stateFile, "utf8").catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (raw === undefined) return new PortRegistry(stateFile, freshState());

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await PortRegistry.quarantine(stateFile);
      return new PortRegistry(stateFile, freshState());
    }

    if (!isValidState(parsed)) {
      await PortRegistry.quarantine(stateFile);
      return new PortRegistry(stateFile, freshState());
    }
    return new PortRegistry(stateFile, parsed);
  }

  private static async quarantine(stateFile: string): Promise<void> {
    await rename(stateFile, `${stateFile}.corrupt`);
  }

  get(podId: string): PodEndpoint | undefined {
    const endpoint = Object.hasOwn(this.state.pods, podId) ? this.state.pods[podId] : undefined;
    return endpoint === undefined ? undefined : { ...endpoint };
  }

  async allocate(podId: string): Promise<PodEndpoint> {
    return this.withMutation(async () => {
      const existing = this.get(podId);
      if (existing !== undefined) return existing;

      const used = new Set(Object.values(this.state.pods).map((endpoint) => endpoint.dbPort));
      let dbPort = DEFAULT_BASE_PORT;
      while (dbPort <= MAX_PORT && (used.has(dbPort) || !(await isPortAvailable(dbPort)))) {
        dbPort += 1;
      }
      if (dbPort > MAX_PORT) throw new Error("PortRegistry: exhausted fleet port range");

      const endpoint = { dbPort };
      this.state = { pods: { ...this.state.pods, [podId]: endpoint } };
      await this.persist();
      return { ...endpoint };
    });
  }

  async release(podId: string): Promise<void> {
    await this.withMutation(async () => {
      const pods = { ...this.state.pods };
      delete pods[podId];
      this.state = { pods };
      await this.persist();
    });
  }

  async reconcile(endpoints: ReadonlyMap<string, PodEndpoint>): Promise<void> {
    await this.withMutation(async () => {
      const pods: Record<string, PodEndpoint> = {};
      const used = new Map<number, string>();
      for (const [podId, endpoint] of endpoints) {
        if (!isPodEndpoint(endpoint)) {
          throw new Error(
            `PortRegistry: cannot reconcile pod "${podId}" with invalid endpoint ${JSON.stringify(endpoint)}`,
          );
        }
        const owner = used.get(endpoint.dbPort);
        if (owner !== undefined) {
          throw new Error(
            `PortRegistry: cannot reconcile pod "${podId}" on port ${endpoint.dbPort}; port already assigned to pod "${owner}"`,
          );
        }
        used.set(endpoint.dbPort, podId);
        pods[podId] = { ...endpoint };
      }
      this.state = { pods };
      await this.persist();
    });
  }

  private async withMutation<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release: () => void = () => {};
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await body();
    } finally {
      release();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.stateFile);
  }
}
