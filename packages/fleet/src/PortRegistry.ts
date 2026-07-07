import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PodPorts {
  readonly dbPort: number;
  readonly apiPort: number;
}

interface PortState {
  readonly basePort: number;
  readonly pods: Record<string, PodPorts>;
}

const DEFAULT_BASE_PORT = 55000;

function freshState(): PortState {
  return { basePort: DEFAULT_BASE_PORT, pods: {} };
}

function isValidState(value: unknown): value is PortState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const { basePort, pods } = candidate;
  if (typeof basePort !== "number" || Number.isNaN(basePort)) return false;
  if (typeof pods !== "object" || pods === null || Array.isArray(pods)) return false;
  return true;
}

/**
 * Persistent registry mapping pod IDs to their allocated `{ dbPort, apiPort }`
 * pair, backed by a single JSON state file on disk.
 *
 * Design assumptions:
 * - **Single owner process.** Exactly one `PortRegistry` instance (the fleet
 *   daemon) is expected to read and write the state file at a time. There is
 *   no file locking or cross-process coordination, so concurrent writers will
 *   silently lose updates (last write wins).
 * - **No host-level port probing.** The registry never checks whether a port
 *   is actually free on the host; it only tracks what it has handed out
 *   itself. The daemon owns the 55000+ range by convention, so nothing else
 *   on the host is expected to bind those ports.
 * - **Corrupt-state recovery.** If the state file is missing, unreadable as
 *   JSON, or structurally invalid, `load()` never throws. Instead it
 *   quarantines the bad file (renaming it to `<stateFile>.corrupt`, replacing
 *   any previous quarantine) and starts from fresh empty state. Since pod
 *   ports are also duplicated in each pod's own manifest (`pod.json`), the
 *   daemon is expected to re-seed the registry after such a reset by calling
 *   `restore()` for each known pod.
 * - **In-process serialization.** Mutating operations are queued so concurrent
 *   lifecycle calls in the owner process cannot interleave writes to the shared
 *   temporary state file.
 */
export class PortRegistry {
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly stateFile: string,
    private state: PortState,
  ) {}

  static async load(stateFile: string): Promise<PortRegistry> {
    const raw = await readFile(stateFile, "utf8").catch(() => undefined);
    if (raw === undefined) {
      return new PortRegistry(stateFile, freshState());
    }

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

  get(podId: string): PodPorts | undefined {
    return this.state.pods[podId];
  }

  async allocate(podId: string): Promise<PodPorts> {
    return this.withMutation(async () => {
      const existing = this.state.pods[podId];
      if (existing) return existing;
      const used = new Set(Object.values(this.state.pods).flatMap((p) => [p.dbPort, p.apiPort]));
      let candidate = this.state.basePort;
      const next = (): number => {
        while (used.has(candidate)) candidate += 1;
        used.add(candidate);
        return candidate;
      };
      const ports: PodPorts = { dbPort: next(), apiPort: next() };
      this.state = { ...this.state, pods: { ...this.state.pods, [podId]: ports } };
      await this.persist();
      return ports;
    });
  }

  /**
   * Records a known allocation (typically read back from a pod's own
   * manifest) without scanning for free ports. Idempotent when the pod
   * already holds exactly these ports. Throws if the pod already holds
   * different ports, or if either port is already assigned to a different
   * pod.
   */
  async restore(podId: string, ports: PodPorts): Promise<void> {
    await this.withMutation(async () => {
      const existing = this.state.pods[podId];
      if (existing) {
        if (existing.dbPort === ports.dbPort && existing.apiPort === ports.apiPort) {
          return;
        }
        throw new Error(
          `PortRegistry: cannot restore pod "${podId}" with ports ${JSON.stringify(ports)}; ` +
            `it is already recorded with different ports ${JSON.stringify(existing)}`,
        );
      }

      const restoredPorts = new Set([ports.dbPort, ports.apiPort]);
      for (const [otherPodId, otherPorts] of Object.entries(this.state.pods)) {
        if (restoredPorts.has(otherPorts.dbPort) || restoredPorts.has(otherPorts.apiPort)) {
          throw new Error(
            `PortRegistry: cannot restore pod "${podId}" with ports ${JSON.stringify(ports)}; ` +
              `port already assigned to pod "${otherPodId}"`,
          );
        }
      }

      this.state = { ...this.state, pods: { ...this.state.pods, [podId]: ports } };
      await this.persist();
    });
  }

  async release(podId: string): Promise<void> {
    await this.withMutation(async () => {
      const rest = { ...this.state.pods };
      delete rest[podId];
      this.state = { ...this.state, pods: rest };
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
