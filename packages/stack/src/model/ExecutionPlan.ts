import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import {
  AuthModule,
  DatabaseModule,
  FunctionsModule,
  MailModule,
  PoolerModule,
  RealtimeModule,
  RestModule,
  StorageModule,
  StudioModule,
  AnalyticsModule,
} from "./capabilities/index.ts";
import type { WorkloadSpec, NativeArtifact, ContainerArtifact } from "./CapabilityModule.ts";

export const CAPABILITY_MODULES = {
  database: DatabaseModule,
  rest: RestModule,
  auth: AuthModule,
  realtime: RealtimeModule,
  storage: StorageModule,
  functions: FunctionsModule,
  studio: StudioModule,
  mail: MailModule,
  analytics: AnalyticsModule,
  pooler: PoolerModule,
};

export interface PlannedWorkload {
  readonly id: string;
  readonly capability: CapabilityName;
  readonly dependencies: ReadonlyArray<string>;
  readonly readiness: WorkloadSpec["readiness"];
  readonly restart: WorkloadSpec["restart"];
  readonly artifacts: Readonly<{
    readonly native: NativeArtifact;
    readonly container: ContainerArtifact;
  }>;
  readonly selected: NativeArtifact | ContainerArtifact;
  readonly specHash: string;
}

export interface ExecutionPlan {
  readonly runtime: StackRuntime;
  readonly startOrder: ReadonlyArray<CapabilityName>;
  readonly stopOrder: ReadonlyArray<CapabilityName>;
  readonly dependencies: Readonly<{ [Name in CapabilityName]: ReadonlyArray<CapabilityName> }>;
  readonly routes: ReadonlyArray<
    Readonly<{
      readonly capability: CapabilityName;
      readonly listener: string;
      readonly protocol: "http" | "tcp";
    }>
  >;
  readonly workloads: ReadonlyArray<PlannedWorkload>;
}

export interface EnabledCapability {
  readonly enabled: boolean;
  readonly activation: "eager" | "lazy";
}

const dependencyMap = {
  database: [],
  rest: ["database"],
  auth: ["database"],
  realtime: ["database"],
  storage: ["database"],
  functions: ["database"],
  studio: ["rest", "analytics"],
  mail: [],
  analytics: ["database"],
  pooler: ["database"],
} satisfies { [Name in CapabilityName]: ReadonlyArray<CapabilityName> };

export const createExecutionPlan = (
  runtime: StackRuntime,
  enabled: Readonly<{ [Name in CapabilityName]: EnabledCapability }>,
  specHashes: ReadonlyMap<string, string>,
): ExecutionPlan => {
  const start: CapabilityName[] = [];
  const visited = new Set<CapabilityName>();
  const visit = (name: CapabilityName): void => {
    if (visited.has(name) || !enabled[name].enabled) return;
    visited.add(name);
    for (const dependency of dependencyMap[name]) visit(dependency);
    start.push(name);
  };
  for (const name of CAPABILITY_NAMES) visit(name);
  const stopOrder = [...start].reverse();
  const routes = CAPABILITY_NAMES.flatMap((name) =>
    enabled[name].enabled
      ? CAPABILITY_MODULES[name].routes.map((route) => ({ capability: name, ...route }))
      : [],
  );
  const declaredWorkloads = CAPABILITY_NAMES.flatMap((name) =>
    enabled[name].enabled
      ? CAPABILITY_MODULES[name].workloads.map((entry) => ({
          id: `${name}:${entry.name}`,
          capability: name,
          dependencies: entry.dependencies,
          readiness: entry.readiness,
          restart: entry.restart,
          artifacts: entry.artifacts,
          selected: runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
          specHash: specHashes.get(`${name}:${entry.name}`) ?? "",
        }))
      : [],
  );
  const byId = new Map(declaredWorkloads.map((entry) => [entry.id, entry]));
  const workloadOrder: typeof declaredWorkloads = [];
  const visiting = new Set<string>();
  const visitedWorkloads = new Set<string>();
  const visitWorkload = (id: string): void => {
    if (visitedWorkloads.has(id) || visiting.has(id)) return;
    const entry = byId.get(id);
    if (entry === undefined) return;
    visiting.add(id);
    for (const dependency of entry.dependencies) visitWorkload(dependency);
    visiting.delete(id);
    visitedWorkloads.add(id);
    workloadOrder.push(entry);
  };
  for (const entry of declaredWorkloads) visitWorkload(entry.id);
  return {
    runtime,
    startOrder: start,
    stopOrder,
    dependencies: dependencyMap,
    routes,
    workloads: workloadOrder,
  };
};
