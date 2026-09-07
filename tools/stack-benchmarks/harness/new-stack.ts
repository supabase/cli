// Benchmark harness for the public @supabase/stack Promise API.
//
// Measures only the public start() call and records host/runtime
// observations after readiness.
// Preparation and the warm start happen before measured samples.
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { promisify } from "node:util";
import { join } from "node:path";
import { captureAtOffsets } from "./memory-collector.ts";

const execFile = promisify(execFileCallback);

type StackEndpoint = { readonly address: string; readonly port: number; readonly url: string };
type StackRuntime =
  | { readonly kind: "native" }
  | { readonly kind: "container"; readonly engine: "docker" };
type StackStatus = {
  readonly lifecycle: string;
  readonly endpoints: Record<string, StackEndpoint | undefined>;
  readonly capabilities: readonly { readonly name: string; readonly state: string }[];
  readonly artifacts: readonly { readonly workloadId: string; readonly state: string }[];
};
type PromiseStackConfig = {
  readonly capabilities: Record<string, { readonly activation: "eager" }>;
};
type PromiseStack = {
  readonly id: string;
  readonly prepare: (options: {
    capabilities: readonly string[];
    config?: PromiseStackConfig;
  }) => Promise<void>;
  readonly start: (options?: { config?: PromiseStackConfig }) => Promise<void>;
  readonly status: () => Promise<StackStatus>;
  readonly credentials: () => Promise<{
    readonly database: { readonly url: string };
    readonly api: { readonly publishableKey: string; readonly serviceRoleJwt: string };
  }>;
  readonly logs: (options: { tail: number }) => Promise<unknown>;
  readonly destroy: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

const benchmarkRoot = process.env.BENCHMARK_ROOT ?? "/tmp/stack-platform-comparison";
const projectsRoot = join(benchmarkRoot, "projects");
const cacheMode = process.env.BENCHMARK_CACHE_MODE ?? "hot";
if (cacheMode !== "cold" && cacheMode !== "hot")
  throw new Error(`Unsupported BENCHMARK_CACHE_MODE: ${cacheMode}`);
const runLabel = (
  process.env.BENCHMARK_RUN_LABEL ?? `run-${Date.now()}-${crypto.randomUUID()}`
).replace(/[^A-Za-z0-9_.-]/gu, "_");
if (runLabel.length === 0) throw new Error("BENCHMARK_RUN_LABEL must not be blank");
const outputRoot = join(benchmarkRoot, cacheMode, runLabel);
const sampleRoot = join(outputRoot, "samples");
const preferredHome = join(benchmarkRoot, "home");
const homeRoot =
  process.env.BENCHMARK_HOME ??
  (cacheMode === "cold"
    ? join(benchmarkRoot, `home-cold-${process.env.BENCHMARK_RUNTIME ?? "all"}`)
    : existsSync(preferredHome)
      ? preferredHome
      : join(benchmarkRoot, "home"));
const sourceRoot = (
  process.env.BENCHMARK_SOURCE_ROOT ?? join(process.cwd(), "packages/stack")
).replace(/\/$/u, "");
const sourceRevision = process.env.BENCHMARK_SOURCE_REVISION ?? "unknown";
if (cacheMode === "cold" && process.env.BENCHMARK_RUNTIME === undefined)
  throw new Error("Cold runs require BENCHMARK_RUNTIME=native or container for an isolated cache");
const skipPrepare = parseBoolean(process.env.BENCHMARK_SKIP_PREPARE, false);
const skipWarmup = parseBoolean(process.env.BENCHMARK_SKIP_WARMUP, false);
const waitPrefetch = parseBoolean(process.env.BENCHMARK_WAIT_PREFETCH, false);
const prefetchTimeoutMs = positiveInteger(
  process.env.BENCHMARK_PREFETCH_TIMEOUT_MS,
  10 * 60_000,
  "BENCHMARK_PREFETCH_TIMEOUT_MS",
);
const sampleCount = positiveInteger(process.env.BENCHMARK_SAMPLES, 3, "BENCHMARK_SAMPLES");
const cpuSampleCount = positiveInteger(
  process.env.BENCHMARK_CPU_SAMPLES,
  3,
  "BENCHMARK_CPU_SAMPLES",
);
const cpuIntervalMs = positiveInteger(
  process.env.BENCHMARK_CPU_INTERVAL_MS,
  250,
  "BENCHMARK_CPU_INTERVAL_MS",
);
const requestStudio = parseBoolean(process.env.BENCHMARK_STUDIO_REQUEST, false);
const restartRequested = parseBoolean(process.env.BENCHMARK_RESTART, false);
const restartAllSamples = parseBoolean(process.env.BENCHMARK_RESTART_ALL, false);
const restartSample = positiveInteger(
  process.env.BENCHMARK_RESTART_SAMPLE,
  1,
  "BENCHMARK_RESTART_SAMPLE",
);
const captureMemory = parseBoolean(process.env.BENCHMARK_MEMORY, false);

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer, received ${value}`);
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`Expected boolean environment value, received ${value}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Set this before importing the public package: the package resolves its
// runtime environment once at the composition boundary.
if (cacheMode === "cold" && process.env.BENCHMARK_HOME === undefined)
  await rm(homeRoot, { recursive: true, force: true });
process.env.SUPABASE_HOME = homeRoot;
const { createStack } = await import(`${sourceRoot}/src/index.ts`);

const CAPABILITIES = [
  "database",
  "rest",
  "auth",
  "realtime",
  "storage",
  "functions",
  "studio",
  "mail",
  "analytics",
  "pooler",
] as const;
const BASE_ARTIFACT_IDS = [
  "analytics:analytics",
  "auth:auth",
  "database:database",
  "functions:edge-runtime",
  "mail:mail",
  "pooler:pooler",
  "realtime:realtime",
  "rest:rest",
  "storage:storage",
  "studio:pgmeta",
  "studio:studio",
] as const;
type Scenario = "default" | "eager";
type RuntimeKind = "native" | "container";
type RuntimeCase = {
  readonly kind: RuntimeKind;
  readonly runtime: StackRuntime;
};

const RUNTIMES: readonly RuntimeCase[] = [
  { kind: "container", runtime: { kind: "container", engine: "docker" } },
  { kind: "native", runtime: { kind: "native" } },
];
const scenarios: readonly Scenario[] = ["default", "eager"];
const selectedRuntimes = RUNTIMES.filter(
  ({ kind }) =>
    process.env.BENCHMARK_RUNTIME === undefined || process.env.BENCHMARK_RUNTIME === kind,
);
const selectedScenarios = scenarios.filter(
  (scenario) =>
    process.env.BENCHMARK_SCENARIO === undefined || process.env.BENCHMARK_SCENARIO === scenario,
);
if (selectedRuntimes.length === 0)
  throw new Error(`Unsupported BENCHMARK_RUNTIME: ${process.env.BENCHMARK_RUNTIME}`);
if (selectedScenarios.length === 0)
  throw new Error(`Unsupported BENCHMARK_SCENARIO: ${process.env.BENCHMARK_SCENARIO}`);

// This sets activation eager for every enabled default capability. It does not
// enable storage image transformation, analytics vector, or any other optional
// workload, so those defaults remain the same as an empty config.
const eagerConfig: PromiseStackConfig = {
  capabilities: {
    rest: { activation: "eager" },
    auth: { activation: "eager" },
    realtime: { activation: "eager" },
    storage: { activation: "eager" },
    functions: { activation: "eager" },
    studio: { activation: "eager" },
    mail: { activation: "eager" },
    analytics: { activation: "eager" },
    pooler: { activation: "eager" },
  },
};

const elapsed = (started: number): number => Math.round((performance.now() - started) * 100) / 100;
const round = (value: number): number => Math.round(value * 100) / 100;
const optionalCommand = async (
  command: string,
  args: readonly string[],
): Promise<string | undefined> => {
  try {
    const result = await execFile(command, [...args], { encoding: "utf8" });
    const output = result.stdout.trim();
    return output.length === 0 ? undefined : output;
  } catch {
    return undefined;
  }
};
const hostMetadata = async (): Promise<Record<string, unknown>> => {
  const [uname, glibc, osRelease, dockerVersion, dockerContext] = await Promise.all([
    optionalCommand("uname", ["-a"]),
    process.platform === "linux"
      ? optionalCommand("getconf", ["GNU_LIBC_VERSION"])
      : Promise.resolve(undefined),
    process.platform === "linux"
      ? readFile("/etc/os-release", "utf8").catch(() => undefined)
      : Promise.resolve(undefined),
    optionalCommand("docker", ["version", "--format", "{{json .}}"]),
    optionalCommand("docker", ["context", "show"]),
  ]);
  return {
    platform: process.platform,
    arch: process.arch,
    bun: process.versions.bun,
    node: process.version,
    versions: process.versions,
    ...(uname === undefined ? {} : { uname }),
    ...(glibc === undefined ? {} : { glibc }),
    ...(osRelease === undefined ? {} : { osRelease }),
    ...(dockerVersion === undefined ? {} : { dockerVersion }),
    ...(dockerContext === undefined ? {} : { dockerContext }),
  };
};
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / values.length);
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const connect = (endpoint: StackEndpoint): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = connectTcp(endpoint.port, endpoint.address);
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
    socket.setTimeout(2_000, () => finish(new Error("database endpoint timed out")));
  });

const endpoint = (status: StackStatus, name: keyof StackStatus["endpoints"]): StackEndpoint => {
  const value = status.endpoints[name];
  if (value === undefined) throw new Error(`Expected ${name} endpoint in stack status`);
  return value;
};

type Readiness = {
  readonly status: StackStatus;
  /** Time spent checking public status, credentials, and TCP readiness after start() returned. */
  readonly readinessCheckMs: number;
};

type StartStatusObservation = {
  readonly observedOffsetMs: number;
  readonly status?: StackStatus;
  readonly error?: string;
};

type StartStatusMonitor = {
  readonly observations: StartStatusObservation[];
  readonly stop: () => Promise<void>;
};

/** Polls the public status surface while start() is running for attribution. */
const monitorStartStatus = (stack: PromiseStack, startStarted: number): StartStatusMonitor => {
  const observations: StartStatusObservation[] = [];
  let active = true;
  const loop = (async (): Promise<void> => {
    while (active) {
      try {
        const status = await stack.status();
        observations.push({ observedOffsetMs: elapsed(startStarted), status });
      } catch (cause) {
        observations.push({
          observedOffsetMs: elapsed(startStarted),
          error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
        });
      }
      if (active) await delay(100);
    }
  })();
  return {
    observations,
    stop: async () => {
      active = false;
      await loop;
    },
  };
};

const assertReady = async (
  stack: PromiseStack,
  scenario: Scenario,
  startEnded: number,
): Promise<Readiness> => {
  const status = await stack.status();
  if (status.lifecycle !== "running")
    throw new Error(`Expected running stack, got ${status.lifecycle}`);
  const database = endpoint(status, "database");
  const credentials = await stack.credentials();
  const databaseUrl = new URL(credentials.database.url);
  if (Number(databaseUrl.port) !== database.port)
    throw new Error(
      `Database credentials port ${databaseUrl.port} differs from endpoint ${database.port}`,
    );
  await connect(database);
  const databaseState = status.capabilities.find(({ name }) => name === "database")?.state;
  if (databaseState !== "ready")
    throw new Error(`Expected database ready, got ${databaseState ?? "missing"}`);
  if (scenario === "eager") {
    const notReady = status.capabilities.filter(({ state }) => state !== "ready");
    if (notReady.length > 0)
      throw new Error(
        `Eager start left capabilities unready: ${notReady.map(({ name, state }) => `${name}=${state}`).join(", ")}`,
      );
  }
  return { status, readinessCheckMs: elapsed(startEnded) };
};

type ArtifactBarrier = {
  readonly artifactReadyMs: number;
  readonly barrierWaitMs: number;
  readonly status: StackStatus;
};

/**
 * Background preparation is deliberately outside startMs. When requested, wait
 * on the public status signal before sampling idle CPU so download work is not
 * mistaken for an idle workload measurement.
 */
const waitForArtifacts = async (
  stack: PromiseStack,
  startStarted: number,
): Promise<ArtifactBarrier> => {
  const barrierStarted = performance.now();
  const pollIntervalMs = 250;
  for (;;) {
    const status = await stack.status();
    if (status.lifecycle !== "running")
      throw new Error(
        `Expected running stack while waiting for artifacts, got ${status.lifecycle}`,
      );
    const failed = status.artifacts.filter(({ state }) => state === "failed");
    if (failed.length > 0)
      throw new Error(
        `Artifact preparation failed: ${failed.map(({ workloadId }) => workloadId).join(", ")}`,
      );
    const ready = new Set(
      status.artifacts.filter(({ state }) => state === "ready").map(({ workloadId }) => workloadId),
    );
    const missing = BASE_ARTIFACT_IDS.filter((workloadId) => !ready.has(workloadId));
    if (missing.length === 0) {
      return {
        artifactReadyMs: elapsed(startStarted),
        barrierWaitMs: elapsed(barrierStarted),
        status,
      };
    }
    if (elapsed(barrierStarted) > prefetchTimeoutMs)
      throw new Error(`Timed out waiting for ${missing.length} artifacts: ${missing.join(", ")}`);
    await delay(pollIntervalMs);
  }
};

type PsProcess = {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
  readonly cpuPercent: number;
  readonly command: string;
  readonly workloadId?: string;
};

const psInventory = async (): Promise<readonly PsProcess[]> => {
  const result = await execFile("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,command="], {
    encoding: "utf8",
  });
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+(.+)$/u.exec(line);
    if (match === null) return [];
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const cpuPercent = Number(match[4]);
    const command = match[5] ?? "";
    if (![pid, ppid, rssKb, cpuPercent].every(Number.isFinite)) return [];
    const workloadId = /supabase-workload-id=([^\s]+)/u.exec(command)?.[1];
    return [
      {
        pid,
        ppid,
        rssKb,
        cpuPercent,
        command,
        ...(workloadId === undefined ? {} : { workloadId }),
      },
    ];
  });
};

const supervisorProcesses = (processes: readonly PsProcess[], stackId: string): PsProcess[] => {
  const matches = processes.filter(
    ({ command }) =>
      command.includes(stackId) &&
      (command.includes("supervisor-node.ts") || command.includes("__supabase_stack_supervisor__")),
  );
  if (matches.length !== 1)
    throw new Error(`Expected one Supervisor process for ${stackId}, found ${matches.length}`);
  return matches;
};

const descendantsOf = (processes: readonly PsProcess[], roots: readonly number[]): PsProcess[] => {
  const children = new Map<number, PsProcess[]>();
  for (const process of processes) {
    const current = children.get(process.ppid) ?? [];
    current.push(process);
    children.set(process.ppid, current);
  }
  const result: PsProcess[] = [];
  const visited = new Set<number>();
  const visit = (pid: number): void => {
    if (visited.has(pid)) return;
    visited.add(pid);
    const process = processes.find(({ pid: candidate }) => candidate === pid);
    if (process !== undefined) result.push(process);
    for (const child of children.get(pid) ?? []) visit(child.pid);
  };
  for (const root of roots) visit(root);
  return result.sort((left, right) => left.pid - right.pid);
};

type NativeProcessSnapshot = {
  readonly sampledAt: string;
  readonly supervisorPids: readonly number[];
  readonly processes: readonly PsProcess[];
  readonly rssKbTotal: number;
  readonly cpuPercentTotal: number;
};

const nativeSnapshot = async (stackId: string): Promise<NativeProcessSnapshot> => {
  const processes = await psInventory();
  const supervisors = supervisorProcesses(processes, stackId);
  const owned = descendantsOf(
    processes,
    supervisors.map(({ pid }) => pid),
  );
  if (owned.length === 0) throw new Error(`No native process tree found for ${stackId}`);
  return {
    sampledAt: new Date().toISOString(),
    supervisorPids: supervisors.map(({ pid }) => pid),
    processes: owned,
    rssKbTotal: owned.reduce((sum, process) => sum + process.rssKb, 0),
    cpuPercentTotal: round(owned.reduce((sum, process) => sum + process.cpuPercent, 0)),
  };
};

const dockerIds = async (stackId: string, all: boolean): Promise<string[]> => {
  const args = [
    "ps",
    ...(all ? ["-aq"] : ["-q"]),
    "--filter",
    `label=com.supabase.stack.stackId=${stackId}`,
  ];
  const result = await execFile("docker", args, { encoding: "utf8" });
  return result.stdout
    .trim()
    .split("\n")
    .filter((id) => id.length > 0);
};

const memoryBytes = (value: string): number => {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]?i?B)\b/u.exec(value);
  if (match === null) throw new Error(`Unable to parse Docker memory value: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "B";
  const factors: Readonly<Record<string, number>> = {
    B: 1,
    kB: 1_000,
    KB: 1_000,
    KiB: 1_024,
    MB: 1_000_000,
    MiB: 1_048_576,
    GB: 1_000_000_000,
    GiB: 1_073_741_824,
    TB: 1_000_000_000_000,
    TiB: 1_099_511_627_776,
    PB: 1_000_000_000_000_000,
    PiB: 1_125_899_906_842_624,
  };
  const factor = factors[unit];
  if (factor === undefined || !Number.isFinite(amount))
    throw new Error(`Unknown Docker memory unit: ${unit}`);
  return Math.round(amount * factor);
};

type DockerContainerStat = {
  readonly id: string;
  readonly name: string;
  readonly memoryBytes: number;
  readonly cpuPercent: number;
};

const dockerStats = async (
  stackId: string,
): Promise<{
  readonly sampledAt: string;
  readonly workloadCount: number;
  readonly ownedWorkloadCount: number;
  readonly runningWorkloadCount: number;
  readonly containers: readonly DockerContainerStat[];
  readonly memoryBytesTotal: number;
  readonly cpuPercentTotal: number;
}> => {
  const [allIds, runningIds] = await Promise.all([
    dockerIds(stackId, true),
    dockerIds(stackId, false),
  ]);
  if (runningIds.length === 0) throw new Error(`No running Docker workloads found for ${stackId}`);
  const result = await execFile(
    "docker",
    ["stats", "--no-stream", "--format", "{{json .}}", ...runningIds],
    { encoding: "utf8" },
  );
  const containers = result.stdout.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [];
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) throw new Error("Docker stats returned a non-object row");
    const record = value;
    const id = typeof record.ID === "string" ? record.ID : undefined;
    const name = typeof record.Name === "string" ? record.Name : undefined;
    const memUsage = typeof record.MemUsage === "string" ? record.MemUsage : undefined;
    const cpu = typeof record.CPUPerc === "string" ? record.CPUPerc : undefined;
    if (id === undefined || name === undefined || memUsage === undefined || cpu === undefined)
      throw new Error("Docker stats row omitted expected fields");
    const cpuPercent = Number(cpu.replace("%", ""));
    if (!Number.isFinite(cpuPercent)) throw new Error(`Unable to parse Docker CPU value: ${cpu}`);
    return [{ id, name, memoryBytes: memoryBytes(memUsage.split("/")[0] ?? ""), cpuPercent }];
  });
  if (containers.length !== runningIds.length)
    throw new Error(
      `Docker stats returned ${containers.length} rows for ${runningIds.length} workloads`,
    );
  return {
    sampledAt: new Date().toISOString(),
    workloadCount: runningIds.length,
    ownedWorkloadCount: allIds.length,
    runningWorkloadCount: runningIds.length,
    containers,
    memoryBytesTotal: containers.reduce((sum, container) => sum + container.memoryBytes, 0),
    cpuPercentTotal: round(containers.reduce((sum, container) => sum + container.cpuPercent, 0)),
  };
};

type HostSupervisorSnapshot = {
  readonly sampledAt: string;
  readonly supervisorPids: readonly number[];
  readonly processes: readonly PsProcess[];
  readonly rssKbTotal: number;
  readonly cpuPercentTotal: number;
};

const hostSupervisorSnapshot = async (stackId: string): Promise<HostSupervisorSnapshot> => {
  const processes = await psInventory();
  const supervisors = supervisorProcesses(processes, stackId);
  return {
    sampledAt: new Date().toISOString(),
    supervisorPids: supervisors.map(({ pid }) => pid),
    processes: supervisors,
    rssKbTotal: supervisors.reduce((sum, process) => sum + process.rssKb, 0),
    cpuPercentTotal: round(supervisors.reduce((sum, process) => sum + process.cpuPercent, 0)),
  };
};

type NativeIdleMetrics = {
  readonly basis: "ps-rss-supervisor-descendants";
  readonly rssKb: number;
  readonly cpuPercentAverage: number;
  readonly snapshots: readonly NativeProcessSnapshot[];
};
type ContainerIdleMetrics = {
  readonly basis: "docker-stats-working-set";
  readonly memoryBytes: number;
  readonly cpuPercentAverage: number;
  readonly workloadCount: number;
  readonly ownedWorkloadCount: number;
  readonly runningWorkloadCount: number;
  readonly snapshots: readonly (Awaited<ReturnType<typeof dockerStats>> & {
    readonly hostSupervisor: HostSupervisorSnapshot;
  })[];
  readonly hostSupervisorRssKb: number;
  readonly hostSupervisorCpuPercentAverage: number;
  readonly hostSupervisorSnapshots: readonly HostSupervisorSnapshot[];
};
type ContainerIdleSnapshot = Awaited<ReturnType<typeof dockerStats>> & {
  readonly hostSupervisor: HostSupervisorSnapshot;
};
type IdleMetrics = NativeIdleMetrics | ContainerIdleMetrics;

const collectIdleMetrics = async (runtime: RuntimeCase, stackId: string): Promise<IdleMetrics> => {
  const nativeSnapshots: NativeProcessSnapshot[] = [];
  const containerSnapshots: ContainerIdleSnapshot[] = [];
  const hostSnapshots: HostSupervisorSnapshot[] = [];
  for (let index = 0; index < cpuSampleCount; index += 1) {
    if (runtime.kind === "native") {
      nativeSnapshots.push(await nativeSnapshot(stackId));
    } else {
      const [docker, hostSupervisor] = await Promise.all([
        dockerStats(stackId),
        hostSupervisorSnapshot(stackId),
      ]);
      hostSnapshots.push(hostSupervisor);
      containerSnapshots.push({ ...docker, hostSupervisor });
    }
    if (index + 1 < cpuSampleCount) await delay(cpuIntervalMs);
  }
  if (runtime.kind === "native") {
    return {
      basis: "ps-rss-supervisor-descendants",
      rssKb: Math.round(median(nativeSnapshots.map(({ rssKbTotal }) => rssKbTotal))),
      cpuPercentAverage: average(nativeSnapshots.map(({ cpuPercentTotal }) => cpuPercentTotal)),
      snapshots: nativeSnapshots,
    };
  }
  const first = containerSnapshots[0];
  if (first === undefined) throw new Error("No Docker idle samples were collected");
  return {
    basis: "docker-stats-working-set",
    memoryBytes: Math.round(
      median(containerSnapshots.map(({ memoryBytesTotal }) => memoryBytesTotal)),
    ),
    cpuPercentAverage: average(containerSnapshots.map(({ cpuPercentTotal }) => cpuPercentTotal)),
    workloadCount: first.workloadCount,
    ownedWorkloadCount: first.ownedWorkloadCount,
    runningWorkloadCount: first.runningWorkloadCount,
    snapshots: containerSnapshots,
    hostSupervisorRssKb: Math.round(median(hostSnapshots.map(({ rssKbTotal }) => rssKbTotal))),
    hostSupervisorCpuPercentAverage: average(
      hostSnapshots.map(({ cpuPercentTotal }) => cpuPercentTotal),
    ),
    hostSupervisorSnapshots: hostSnapshots,
  };
};

type StudioRequest = {
  readonly requestMs: number;
  readonly httpStatus: number;
  readonly statusAfterRequest: StackStatus;
};

const firstStudioRequest = async (
  stack: PromiseStack,
  status: StackStatus,
): Promise<StudioRequest> => {
  const studio = endpoint(status, "studio");
  const credentials = await stack.credentials();
  const started = performance.now();
  const response = await fetch(`${studio.url}/api/platform/profile`, {
    headers: {
      apikey: credentials.api.publishableKey,
      Authorization: `Bearer ${credentials.api.serviceRoleJwt}`,
    },
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Studio profile returned ${response.status}: ${body}`);
  const statusAfterRequest = await stack.status();
  const studioState = statusAfterRequest.capabilities.find(({ name }) => name === "studio")?.state;
  if (studioState !== "ready")
    throw new Error(`Expected Studio ready after request, got ${studioState ?? "missing"}`);
  return { requestMs: elapsed(started), httpStatus: response.status, statusAfterRequest };
};

const createProject = async (prefix: string): Promise<string> => {
  await mkdir(projectsRoot, { recursive: true });
  return mkdtemp(join(projectsRoot, `${prefix}-`));
};

const configFor = (scenario: Scenario): PromiseStackConfig | undefined =>
  scenario === "eager" ? eagerConfig : undefined;
const startOptionsFor = (scenario: Scenario) => {
  const config = configFor(scenario);
  return config === undefined ? undefined : { config };
};

const destroyExact = async (
  stack: PromiseStack | undefined,
  projectRoot: string,
): Promise<void> => {
  let failure: unknown;
  if (stack !== undefined) {
    try {
      await stack.destroy();
    } catch (cause) {
      failure = cause;
    }
  }
  try {
    await rm(projectRoot, { recursive: true, force: true });
  } catch (cause) {
    if (failure === undefined) failure = cause;
  }
  if (failure !== undefined) throw failure;
};

const prepareAndWarm = async (runtime: RuntimeCase, scenario: Scenario): Promise<void> => {
  const projectRoot = await createProject(`warm-${runtime.kind}-${scenario}`);
  let stack: PromiseStack | undefined;
  let destroyed = false;
  try {
    const createdStack = await createStack({
      projectRoot,
      name: `stack-platform-comparison-warm-${runtime.kind}-${scenario}-${crypto.randomUUID()}`,
      runtime: runtime.runtime,
    });
    stack = createdStack;
    const config = configFor(scenario);
    if (!skipPrepare)
      await createdStack.prepare({
        capabilities: [...CAPABILITIES],
        ...(config === undefined ? {} : { config }),
      });
    if (!skipWarmup) {
      await createdStack.start(startOptionsFor(scenario));
      await assertReady(createdStack, scenario, performance.now());
    }
    await createdStack.destroy();
    destroyed = true;
  } finally {
    if (!destroyed) await destroyExact(stack, projectRoot);
    else await rm(projectRoot, { recursive: true, force: true });
  }
};

type Measurement = {
  readonly sourceRevision: string;
  readonly runtime: RuntimeCase["runtime"];
  readonly scenario: Scenario;
  readonly sample: number;
  readonly projectRoot: string;
  readonly stackId: string;
  readonly createMs: number;
  readonly startMs: number;
  readonly readinessCheckMs: number;
  readonly startStatusObservations: readonly StartStatusObservation[];
  readonly logsAfterReady?: unknown;
  readonly artifactBarrier?: ArtifactBarrier;
  readonly memoryCapture?: Awaited<ReturnType<typeof captureAtOffsets>>;
  readonly idle: IdleMetrics;
  readonly studio?: StudioRequest;
  readonly restart?: {
    readonly startMs: number;
    readonly readinessCheckMs: number;
  };
  readonly stopMs: number;
  readonly status: StackStatus;
};

const failurePath = (runtime: RuntimeCase, scenario: Scenario, sample: number): string =>
  join(sampleRoot, `failure-${runtime.kind}-${scenario}-${sample}.json`);
const samplePath = (runtime: RuntimeCase, scenario: Scenario, sample: number): string =>
  join(sampleRoot, `sample-${runtime.kind}-${scenario}-${sample}.json`);

const runSample = async (
  runtime: RuntimeCase,
  scenario: Scenario,
  sample: number,
): Promise<Measurement> => {
  const projectRoot = await createProject(`sample-${runtime.kind}-${scenario}-${sample}`);
  let stack: PromiseStack | undefined;
  let startStatusObservations: readonly StartStatusObservation[] = [];
  const includeRestart = restartRequested && (restartAllSamples || sample === restartSample);
  try {
    const createStarted = performance.now();
    const createdStack = await createStack({
      projectRoot,
      name: `stack-platform-comparison-${runtime.kind}-${scenario}-${sample}-${crypto.randomUUID()}`,
      runtime: runtime.runtime,
    });
    stack = createdStack;
    const createMs = elapsed(createStarted);
    const startStarted = performance.now();
    const statusMonitor = monitorStartStatus(createdStack, startStarted);
    let startMs = 0;
    try {
      await createdStack.start(startOptionsFor(scenario));
      startMs = elapsed(startStarted);
    } finally {
      await statusMonitor.stop();
      startStatusObservations = statusMonitor.observations;
    }
    const readiness = await assertReady(createdStack, scenario, performance.now());
    const logsAfterReady = await createdStack.logs({ tail: 5000 }).catch(() => undefined);
    const artifactBarrier = waitPrefetch
      ? await waitForArtifacts(createdStack, startStarted)
      : undefined;
    const memoryCapture = captureMemory
      ? await captureAtOffsets({
          runtime: runtime.kind,
          stackId: createdStack.id,
          projectLabel: "com.supabase.stack.stackId=" + createdStack.id,
        })
      : undefined;
    const idle = await collectIdleMetrics(runtime, createdStack.id);
    const studio = requestStudio
      ? await firstStudioRequest(createdStack, readiness.status)
      : undefined;
    let restart: Measurement["restart"];
    if (includeRestart) {
      await createdStack.stop();
      const restartStarted = performance.now();
      await createdStack.start(startOptionsFor(scenario));
      const restartStartMs = elapsed(restartStarted);
      const restartReadiness = await assertReady(createdStack, scenario, performance.now());
      restart = {
        startMs: restartStartMs,
        readinessCheckMs: restartReadiness.readinessCheckMs,
      };
    }
    const stopStarted = performance.now();
    await createdStack.stop();
    const stopMs = elapsed(stopStarted);
    const measurement: Measurement = {
      sourceRevision,
      runtime: runtime.runtime,
      scenario,
      sample,
      projectRoot,
      stackId: createdStack.id,
      createMs,
      startMs,
      readinessCheckMs: readiness.readinessCheckMs,
      startStatusObservations,
      logsAfterReady,
      ...(artifactBarrier === undefined ? {} : { artifactBarrier }),
      ...(memoryCapture === undefined ? {} : { memoryCapture }),
      idle,
      ...(studio === undefined ? {} : { studio }),
      ...(restart === undefined ? {} : { restart }),
      stopMs,
      status: readiness.status,
    };
    await writeJson(samplePath(runtime, scenario, sample), measurement);
    return measurement;
  } catch (cause) {
    let status: unknown;
    let logs: unknown;
    if (stack !== undefined) {
      status = await stack.status().catch(() => undefined);
      logs = await stack.logs({ tail: 5000 }).catch(() => undefined);
    }
    await writeJson(failurePath(runtime, scenario, sample), {
      sourceRevision,
      runtime: runtime.runtime,
      scenario,
      sample,
      projectRoot,
      error:
        cause instanceof Error
          ? `${cause.name}: ${cause.message}\n${cause.stack ?? ""}`
          : String(cause),
      status,
      startStatusObservations,
      logs,
    });
    throw cause;
  } finally {
    await destroyExact(stack, projectRoot);
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(sampleRoot, { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
};

const measurementNotes = {
  startMs:
    "Wall-clock duration of public PromiseStack.start() only; createStack(), prepare(), and readiness checks are outside this timer.",
  readiness:
    "After start() resolves, status(), credentials(), and a guarded TCP connection to the published database endpoint are checked and timed separately.",
  startStatus:
    "startStatusObservations records status() results sampled approximately every 100ms while start() is pending. observedOffsetMs is the first observation time, not an internal phase boundary; missing/error observations are retained. A capability or artifact is considered ready at the first sampled status that reports state=ready.",
  preparation:
    "Hot runs prepare all enabled default capabilities, then perform one real warm start and destroy before measured samples; set BENCHMARK_SKIP_PREPARE and BENCHMARK_SKIP_WARMUP for cold runs. Optional storage imgproxy and analytics vector remain disabled by default; the expected base artifact set has 11 workloads.",
  cache:
    "BENCHMARK_CACHE_MODE=hot reuses the prior native cache when present; BENCHMARK_CACHE_MODE=cold uses and clears an isolated home-cold-* directory. Docker image eviction is intentionally external: remove only exact tested image references before a cold Docker invocation.",
  containerMemory:
    "Docker memory is the sum of one-shot docker stats working-set readings for running containers filtered by the exact com.supabase.stack.stackId label; three readings are retained and their median is reported. workloadCount is the running count used by stats; ownedWorkloadCount also records all exact-label containers.",
  nativeMemory:
    "Native RSS is ps RSS in KiB for the exact Supervisor process and its PID/PPID descendants; it includes the host Supervisor and is not directly comparable to Docker working-set memory.",
  dockerHostSupervisor:
    "Docker cases separately record the host Supervisor RSS/CPU from ps; it is excluded from the Docker memory total because that total stays on the docker stats basis.",
  idleCpu:
    "CPU is instantaneous idle context only: Docker stats or ps values averaged across the configured BENCHMARK_CPU_SAMPLES readings spaced by BENCHMARK_CPU_INTERVAL_MS; it is not total startup CPU.",
  studio:
    "When BENCHMARK_STUDIO_REQUEST is true, the first Studio profile HTTP request runs only after idle metrics are complete.",
  prefetch:
    "When BENCHMARK_WAIT_PREFETCH is true, public status is polled until all 11 enabled base artifact statuses are ready; artifactReadyMs remains separate from startMs and idle sampling begins after the barrier.",
  memory:
    "When BENCHMARK_MEMORY=1, each fresh measured stack is observed at requested offsets 30,000/35,000/40,000ms after readiness and the optional artifact barrier. Actual offsets and per-process RSS/PSS/private/swap snapshots are retained; missing owned processes fail the run.",
  cleanup:
    "Every project uses a unique root and stack identity; cleanup calls only that stack's public destroy() and removes that exact temporary project root.",
  logs: "logsAfterReady is a best-effort 5,000-line public log snapshot captured after readiness and outside the start timer; failure logs use the same tail for diagnosis.",
};

const summaryMedians = (measurements: readonly Measurement[]) => {
  const groups = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const runtime = measurement.runtime.kind === "container" ? "container" : "native";
    const key = `${runtime}/${measurement.scenario}`;
    groups.set(key, [...(groups.get(key) ?? []), measurement]);
  }
  return [...groups.entries()].map(([key, values]) => {
    const first = values[0];
    const runtime = first?.runtime.kind;
    return {
      key,
      sampleCount: values.length,
      startMs: median(values.map(({ startMs }) => startMs)),
      readinessCheckMs: median(values.map(({ readinessCheckMs }) => readinessCheckMs)),
      stopMs: median(values.map(({ stopMs }) => stopMs)),
      ...(values.some(({ artifactBarrier }) => artifactBarrier !== undefined)
        ? {
            artifactReadyMs: median(
              values.map(({ artifactBarrier }) => artifactBarrier?.artifactReadyMs ?? 0),
            ),
            barrierWaitMs: median(
              values.map(({ artifactBarrier }) => artifactBarrier?.barrierWaitMs ?? 0),
            ),
          }
        : {}),
      ...(runtime === "container"
        ? {
            dockerMemoryBytes: median(
              values.flatMap(({ idle }) =>
                idle.basis === "docker-stats-working-set" ? [idle.memoryBytes] : [],
              ),
            ),
            dockerCpuPercentAverage: average(
              values.flatMap(({ idle }) =>
                idle.basis === "docker-stats-working-set" ? [idle.cpuPercentAverage] : [],
              ),
            ),
            workloadCount: median(
              values.flatMap(({ idle }) =>
                idle.basis === "docker-stats-working-set" ? [idle.workloadCount] : [],
              ),
            ),
            ownedWorkloadCount: median(
              values.flatMap(({ idle }) =>
                idle.basis === "docker-stats-working-set" ? [idle.ownedWorkloadCount] : [],
              ),
            ),
            hostSupervisorRssKb: median(
              values.flatMap(({ idle }) =>
                idle.basis === "docker-stats-working-set" ? [idle.hostSupervisorRssKb] : [],
              ),
            ),
          }
        : {
            nativeRssKb: median(
              values.flatMap(({ idle }) =>
                idle.basis === "ps-rss-supervisor-descendants" ? [idle.rssKb] : [],
              ),
            ),
            nativeCpuPercentAverage: average(
              values.flatMap(({ idle }) =>
                idle.basis === "ps-rss-supervisor-descendants" ? [idle.cpuPercentAverage] : [],
              ),
            ),
          }),
      ...(values.some(({ restart }) => restart !== undefined)
        ? {
            restartStartMs: median(
              values.flatMap(({ restart }) => (restart === undefined ? [] : [restart.startMs])),
            ),
            restartReadinessCheckMs: median(
              values.flatMap(({ restart }) =>
                restart === undefined ? [] : [restart.readinessCheckMs],
              ),
            ),
          }
        : {}),
      ...(values.some(({ studio }) => studio !== undefined)
        ? { studioRequestMs: median(values.map(({ studio }) => studio?.requestMs ?? 0)) }
        : {}),
    };
  });
};

const main = async (): Promise<void> => {
  await mkdir(benchmarkRoot, { recursive: true });
  await mkdir(sampleRoot, { recursive: true });
  const host = await hostMetadata();
  const measurements: Measurement[] = [];
  console.log(
    JSON.stringify({
      event: "benchmark-start",
      sourceRevision,
      sourceRoot,
      homeRoot,
      cacheMode,
      runLabel,
      skipPrepare,
      skipWarmup,
      waitPrefetch,
      prefetchTimeoutMs,
      memoryCapture: captureMemory,
      host,
      sampleCount,
      cpuSampleCount,
      cpuIntervalMs,
      requestStudio,
      restartRequested,
      restartSample: restartAllSamples ? "all" : restartSample,
      cases: selectedRuntimes.flatMap(({ kind }) =>
        selectedScenarios.map((scenario) => `${kind}/${scenario}`),
      ),
      measurementNotes,
    }),
  );
  for (const runtime of selectedRuntimes) {
    for (const scenario of selectedScenarios) {
      console.log(JSON.stringify({ event: "warmup-start", runtime: runtime.kind, scenario }));
      if (!skipPrepare || !skipWarmup) {
        await prepareAndWarm(runtime, scenario);
        console.log(JSON.stringify({ event: "warmup-complete", runtime: runtime.kind, scenario }));
      } else {
        console.log(JSON.stringify({ event: "warmup-skipped", runtime: runtime.kind, scenario }));
      }
      for (let sample = 1; sample <= sampleCount; sample += 1) {
        console.log(
          JSON.stringify({
            event: "sample-start",
            runtime: runtime.kind,
            scenario,
            sample,
            sampleCount,
          }),
        );
        const measurement = await runSample(runtime, scenario, sample);
        measurements.push(measurement);
        console.log(
          JSON.stringify({
            event: "sample-complete",
            runtime: runtime.kind,
            scenario,
            sample,
            stackId: measurement.stackId,
            startMs: measurement.startMs,
            readinessCheckMs: measurement.readinessCheckMs,
            idleMemory:
              measurement.idle.basis === "docker-stats-working-set"
                ? {
                    bytes: measurement.idle.memoryBytes,
                    workloadCount: measurement.idle.workloadCount,
                  }
                : { rssKb: measurement.idle.rssKb },
            samplePath: samplePath(runtime, scenario, sample),
          }),
        );
      }
    }
  }
  const summary = {
    event: "benchmark-complete",
    sourceRevision,
    sourceRoot,
    homeRoot,
    cacheMode,
    runLabel,
    skipPrepare,
    skipWarmup,
    waitPrefetch,
    prefetchTimeoutMs,
    memoryCapture: captureMemory,
    host,
    sampleCount,
    cpuSampleCount,
    cpuIntervalMs,
    requestStudio,
    restartRequested,
    restartSample: restartAllSamples ? "all" : restartSample,
    measurementNotes,
    measurements,
    medians: summaryMedians(measurements),
  };
  const summaryPath = join(outputRoot, "new-stack-summary.json");
  await writeJson(summaryPath, summary);
  console.log(JSON.stringify({ ...summary, summaryPath }));
};

await main();
