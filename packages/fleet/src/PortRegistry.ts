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

export class PortRegistry {
  private constructor(
    private readonly stateFile: string,
    private state: PortState,
  ) {}

  static async load(stateFile: string): Promise<PortRegistry> {
    const raw = await readFile(stateFile, "utf8").catch(() => undefined);
    const state: PortState =
      raw !== undefined
        ? (JSON.parse(raw) as PortState)
        : { basePort: DEFAULT_BASE_PORT, pods: {} };
    return new PortRegistry(stateFile, state);
  }

  get(podId: string): PodPorts | undefined {
    return this.state.pods[podId];
  }

  async allocate(podId: string): Promise<PodPorts> {
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
  }

  async release(podId: string): Promise<void> {
    const rest = { ...this.state.pods };
    delete rest[podId];
    this.state = { ...this.state, pods: rest };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.stateFile);
  }
}
