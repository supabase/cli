import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PORT_FIELDS, type AllocatedPorts } from "@supabase/stack";

export interface PodPorts {
  readonly ports: AllocatedPorts;
  readonly internalPorts: AllocatedPorts;
}

interface PortState {
  readonly basePort: number;
  readonly internalBasePort: number;
  readonly pods: Record<string, PodPorts>;
}

const DEFAULT_BASE_PORT = 55000;
const DEFAULT_INTERNAL_BASE_PORT = 45000;
const INTERNAL_MAX_PORT = DEFAULT_BASE_PORT - 1;
const MAX_PORT = 65_535;

function freshState(): PortState {
  return { basePort: DEFAULT_BASE_PORT, internalBasePort: DEFAULT_INTERNAL_BASE_PORT, pods: {} };
}

function getOwnPodPorts(pods: Record<string, PodPorts>, podId: string): PodPorts | undefined {
  return Object.hasOwn(pods, podId) ? pods[podId] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFleetPort(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value > 10_000 && value <= MAX_PORT
  );
}

function isValidPortSet(value: unknown): value is AllocatedPorts {
  if (!isRecord(value)) return false;
  for (const field of PORT_FIELDS) {
    if (!isFleetPort(value[field])) return false;
  }
  return true;
}

function isValidPodPorts(value: unknown): value is PodPorts {
  if (!isRecord(value)) return false;
  return isValidPortSet(value.ports) && isValidPortSet(value.internalPorts);
}

function isValidState(value: unknown): value is PortState {
  if (!isRecord(value)) return false;
  const { basePort, internalBasePort, pods } = value;
  if (!isFleetPort(basePort) || basePort < DEFAULT_BASE_PORT) return false;
  if (!isFleetPort(internalBasePort) || internalBasePort > INTERNAL_MAX_PORT) return false;
  if (!isRecord(pods)) return false;
  for (const allocation of Object.values(pods)) {
    if (!isValidPodPorts(allocation)) return false;
  }
  return true;
}

function allocatedPorts(allocation: PodPorts): ReadonlyArray<number> {
  return [
    ...PORT_FIELDS.map((field) => allocation.ports[field]),
    ...PORT_FIELDS.map((field) => allocation.internalPorts[field]),
  ];
}

function sameAllocation(a: PodPorts, b: PodPorts): boolean {
  return PORT_FIELDS.every(
    (field) =>
      a.ports[field] === b.ports[field] && a.internalPorts[field] === b.internalPorts[field],
  );
}

function allocatePortSet(next: () => number): AllocatedPorts {
  return {
    dbPort: next(),
    apiPort: next(),
    authPort: next(),
    postgrestPort: next(),
    postgrestAdminPort: next(),
    edgeRuntimePort: next(),
    edgeRuntimeInspectorPort: next(),
    realtimePort: next(),
    storagePort: next(),
    imgproxyPort: next(),
    mailpitPort: next(),
    mailpitSmtpPort: next(),
    mailpitPop3Port: next(),
    pgmetaPort: next(),
    studioPort: next(),
    analyticsPort: next(),
    poolerPort: next(),
    poolerApiPort: next(),
  };
}

/**
 * Persistent registry mapping pod IDs to their allocated stack ports, backed
 * by a single JSON state file on disk.
 *
 * Design assumptions:
 * - **Single owner process.** Exactly one `PortRegistry` instance (the fleet
 *   daemon) is expected to read and write the state file at a time. There is
 *   no file locking or cross-process coordination, so concurrent writers will
 *   silently lose updates (last write wins).
 * - **No host-level port probing.** The registry never checks whether a port
 *   is actually free on the host; it only tracks what it has handed out
 *   itself. The daemon owns the 55000+ range by convention, so nothing else
 *   on the host is expected to bind those ports. Public proxy listeners use
 *   the 55000+ range, while in-process stack services use separately allocated
 *   ports below that public range.
 * - **Corrupt-state recovery.** If the state file is missing, unreadable as
 *   JSON, or structurally invalid, `load()` never throws. Instead it
 *   quarantines the bad file (renaming it to `<stateFile>.corrupt`, replacing
 *   any previous quarantine) and starts from fresh empty state. Since pod
 *   ports are also duplicated in each pod's own manifest (`pod.json`), the
 *   daemon reconciles the registry from valid manifests after such a reset.
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
    return getOwnPodPorts(this.state.pods, podId);
  }

  async allocate(podId: string): Promise<PodPorts> {
    return this.withMutation(async () => {
      const existing = getOwnPodPorts(this.state.pods, podId);
      if (existing) return existing;
      const used = new Set(
        Object.values(this.state.pods).flatMap((allocation) => allocatedPorts(allocation)),
      );
      let publicCandidate = this.state.basePort;
      let internalCandidate = this.state.internalBasePort;
      const nextPublic = (): number => {
        while (used.has(publicCandidate)) publicCandidate += 1;
        if (publicCandidate > MAX_PORT) {
          throw new Error("PortRegistry: exhausted fleet port range");
        }
        const port = publicCandidate;
        used.add(port);
        publicCandidate += 1;
        return port;
      };
      const nextInternal = (): number => {
        while (used.has(internalCandidate)) internalCandidate += 1;
        if (internalCandidate > INTERNAL_MAX_PORT) {
          throw new Error("PortRegistry: exhausted internal fleet port range");
        }
        const port = internalCandidate;
        used.add(port);
        internalCandidate += 1;
        return port;
      };
      const allocation = {
        ports: allocatePortSet(nextPublic),
        internalPorts: allocatePortSet(nextInternal),
      };
      this.state = { ...this.state, pods: { ...this.state.pods, [podId]: allocation } };
      await this.persist();
      return allocation;
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
      const existing = getOwnPodPorts(this.state.pods, podId);
      if (existing) {
        if (sameAllocation(existing, ports)) {
          return;
        }
        throw new Error(
          `PortRegistry: cannot restore pod "${podId}" with ports ${JSON.stringify(ports)}; ` +
            `it is already recorded with different ports ${JSON.stringify(existing)}`,
        );
      }

      const restoredPorts = allocatedPorts(ports);
      if (new Set(restoredPorts).size !== restoredPorts.length) {
        throw new Error(
          `PortRegistry: cannot restore pod "${podId}" with ports ${JSON.stringify(ports)}; ` +
            "allocation contains duplicate ports",
        );
      }
      const restoredPortSet = new Set(restoredPorts);
      for (const [otherPodId, otherPorts] of Object.entries(this.state.pods)) {
        if (allocatedPorts(otherPorts).some((port) => restoredPortSet.has(port))) {
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

  async reconcile(podPorts: ReadonlyMap<string, PodPorts>): Promise<void> {
    await this.withMutation(async () => {
      const nextPods: Record<string, PodPorts> = {};
      const used = new Map<number, string>();
      for (const [podId, ports] of podPorts) {
        for (const port of allocatedPorts(ports)) {
          const owner = used.get(port);
          if (owner !== undefined) {
            throw new Error(
              `PortRegistry: cannot reconcile pod "${podId}" with ports ${JSON.stringify(ports)}; ` +
                `port already assigned to pod "${owner}"`,
            );
          }
          used.set(port, podId);
        }
        nextPods[podId] = ports;
      }
      this.state = { ...this.state, pods: nextPods };
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
