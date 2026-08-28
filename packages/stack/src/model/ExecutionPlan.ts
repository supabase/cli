import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { PortField } from "../public/Status.ts";
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
import { Effect } from "effect";
import { InvalidStackConfigError } from "../public/Errors.ts";

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
  readonly bootstrap?: WorkloadSpec["bootstrap"];
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
      readonly listener: PortField;
      readonly protocol: "http" | "tcp";
    }>
  >;
  readonly workloads: ReadonlyArray<PlannedWorkload>;
}

export interface EnabledCapability {
  readonly enabled: boolean;
  readonly activation: "eager" | "lazy";
}

export const createExecutionPlan = (
  runtime: StackRuntime,
  enabled: Readonly<{ [Name in CapabilityName]: EnabledCapability }>,
  specHashes: ReadonlyMap<string, string>,
  versions: Readonly<{ [Name in CapabilityName]: string }>,
  modules: typeof CAPABILITY_MODULES = CAPABILITY_MODULES,
): Effect.Effect<ExecutionPlan, InvalidStackConfigError> => {
  const dependencyMap = {
    database: modules.database.dependencies,
    rest: modules.rest.dependencies,
    auth: modules.auth.dependencies,
    realtime: modules.realtime.dependencies,
    storage: modules.storage.dependencies,
    functions: modules.functions.dependencies,
    studio: modules.studio.dependencies,
    mail: modules.mail.dependencies,
    analytics: modules.analytics.dependencies,
    pooler: modules.pooler.dependencies,
  } satisfies { [Name in CapabilityName]: ReadonlyArray<CapabilityName> };
  for (const name of CAPABILITY_NAMES) {
    if (!enabled[name].enabled) continue;
    for (const dependency of dependencyMap[name]) {
      if (!enabled[dependency].enabled) {
        return Effect.fail(
          new InvalidStackConfigError({
            message: `${name} requires disabled capability ${dependency}`,
            capability: name,
            dependency,
          }),
        );
      }
    }
  }
  const start: CapabilityName[] = [];
  const visited = new Set<CapabilityName>();
  const visitingCapabilities = new Set<CapabilityName>();
  let capabilityGraphError: InvalidStackConfigError | undefined;
  const visit = (name: CapabilityName): void => {
    if (visitingCapabilities.has(name)) {
      capabilityGraphError = new InvalidStackConfigError({
        message: `Capability dependency cycle detected at ${name}`,
        capability: name,
      });
      return;
    }
    if (visited.has(name) || !enabled[name].enabled) return;
    visitingCapabilities.add(name);
    visited.add(name);
    for (const dependency of dependencyMap[name]) {
      if (!Object.hasOwn(modules, dependency)) {
        capabilityGraphError = new InvalidStackConfigError({
          message: `Unknown capability dependency ${dependency}`,
          capability: name,
          dependency,
        });
        continue;
      }
      visit(dependency);
    }
    visitingCapabilities.delete(name);
    start.push(name);
  };
  for (const name of CAPABILITY_NAMES) visit(name);
  if (capabilityGraphError !== undefined) return Effect.fail(capabilityGraphError);
  const stopOrder = [...start].reverse();
  const routes = CAPABILITY_NAMES.flatMap((name) =>
    enabled[name].enabled
      ? modules[name].routes.map((route) => ({ capability: name, ...route }))
      : [],
  );
  const declaredWorkloads = CAPABILITY_NAMES.flatMap((name) => {
    if (!enabled[name].enabled) return [];
    const release = modules[name].releases[versions[name]];
    if (release === undefined) return [];
    return release.workloads.map((entry) => ({
      id: `${name}:${entry.name}`,
      capability: name,
      ...(entry.bootstrap === undefined ? {} : { bootstrap: entry.bootstrap }),
      dependencies: entry.dependencies,
      readiness: entry.readiness,
      restart: entry.restart,
      artifacts: entry.artifacts,
      selected: runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
      specHash: specHashes.get(`${name}:${entry.name}`) ?? "",
    }));
  });
  const byId = new Map(declaredWorkloads.map((entry) => [entry.id, entry]));
  const workloadOrder: typeof declaredWorkloads = [];
  const visiting = new Set<string>();
  const visitedWorkloads = new Set<string>();
  let graphError: InvalidStackConfigError | undefined;
  const visitWorkload = (id: string): void => {
    if (visitedWorkloads.has(id)) return;
    if (visiting.has(id)) {
      graphError = new InvalidStackConfigError({
        message: `Workload dependency cycle detected at ${id}`,
        workload: id,
      });
      return;
    }
    const entry = byId.get(id);
    if (entry === undefined) {
      graphError = new InvalidStackConfigError({
        message: `Missing private workload dependency ${id}`,
        workload: id,
      });
      return;
    }
    visiting.add(id);
    for (const dependency of entry.dependencies) visitWorkload(dependency);
    visiting.delete(id);
    visitedWorkloads.add(id);
    workloadOrder.push(entry);
  };
  for (const entry of declaredWorkloads) visitWorkload(entry.id);
  if (graphError !== undefined) return Effect.fail(graphError);
  return Effect.succeed({
    runtime,
    startOrder: start,
    stopOrder,
    dependencies: dependencyMap,
    routes,
    workloads: workloadOrder,
  });
};
