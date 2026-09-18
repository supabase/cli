import { Effect } from "effect";
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { PortField } from "../public/Status.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import type {
  WorkloadSpec,
  NativeArtifact,
  ContainerArtifact,
  MaterializedSettings,
} from "./CapabilityModule.ts";
import type { AnalyticsSettings } from "./capabilities/analytics.ts";
import type { AuthSettings } from "./capabilities/auth.ts";
import type { DatabaseSettings } from "./capabilities/database.ts";
import type { FunctionsSettings } from "./capabilities/functions.ts";
import type { MailSettings } from "./capabilities/mail.ts";
import type { PoolerSettings } from "./capabilities/pooler.ts";
import type { RealtimeSettings } from "./capabilities/realtime.ts";
import type { RestSettings } from "./capabilities/rest.ts";
import type { StorageSettings } from "./capabilities/storage.ts";
import type { StudioSettings } from "./capabilities/studio.ts";
import type { PersistedServiceInstance, PersistedServiceRegistry } from "./ServiceRegistry.ts";
import { InvalidStackConfigError } from "../public/Errors.ts";
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
  /** Runtime identity; recipeId remains stable across service instances. */
  readonly instanceId: ServiceInstanceId;
  readonly recipeId: string;
  readonly capability: CapabilityName;
  readonly bootstrap?: WorkloadSpec["bootstrap"];
  readonly dependencies: ReadonlyArray<string>;
  readonly readiness: WorkloadSpec["readiness"];
  readonly artifacts: Readonly<{
    readonly native: NativeArtifact;
    readonly container: ContainerArtifact;
  }>;
  readonly selected: NativeArtifact | ContainerArtifact;
}

export interface ExecutionPlan {
  readonly runtime: StackRuntime;
  /** Activation policy keyed by the immutable service instance ID. */
  readonly activation: Readonly<Record<ServiceInstanceId, "eager" | "lazy">>;
  readonly startOrder: ReadonlyArray<ServiceInstanceId>;
  readonly dependencies: Readonly<Record<ServiceInstanceId, ReadonlyArray<ServiceInstanceId>>>;
  readonly routes: ReadonlyArray<
    Readonly<{
      readonly instanceId: ServiceInstanceId;
      readonly capability: CapabilityName;
      readonly listener: PortField;
      readonly protocol: "http" | "tcp";
    }>
  >;
  readonly workloads: ReadonlyArray<PlannedWorkload>;
}

/** Returns the requested service instances and every transitive dependency. */
export const dependencyClosure = (
  plan: ExecutionPlan,
  roots: Iterable<ServiceInstanceId>,
): Set<ServiceInstanceId> => {
  const closure = new Set<ServiceInstanceId>();
  const visit = (id: ServiceInstanceId): void => {
    if (closure.has(id)) return;
    closure.add(id);
    for (const dependency of plan.dependencies[id] ?? []) visit(dependency);
  };
  for (const root of roots) visit(root);
  return closure;
};

export const activeExecutionPlan = (
  plan: ExecutionPlan,
  active: ReadonlySet<ServiceInstanceId>,
): ExecutionPlan => ({
  ...plan,
  workloads: plan.workloads.filter((workload) => active.has(workload.instanceId)),
  startOrder: plan.startOrder.filter((id) => active.has(id)),
});

const selectedWorkloadsForInstance = (
  instance: PersistedServiceInstance,
  modules: typeof CAPABILITY_MODULES,
  workloads: ReadonlyArray<WorkloadSpec>,
): ReadonlyArray<WorkloadSpec> => {
  switch (instance.service) {
    case "database":
      return modules.database.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "rest":
      return modules.rest.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "auth":
      return modules.auth.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "realtime":
      return modules.realtime.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "storage":
      return modules.storage.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "functions":
      return modules.functions.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "studio":
      return modules.studio.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "mail":
      return modules.mail.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "analytics":
      return modules.analytics.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
    case "pooler":
      return modules.pooler.selectWorkloads?.(instance.config.settings, workloads) ?? workloads;
  }
};

const hasOwnedRuntime = (instance: PersistedServiceInstance): boolean =>
  instance.config.enabled ||
  Object.keys(instance.resources).length > 0 ||
  instance.data.origin !== "absent" ||
  instance.pendingOperation !== null;

const dependencyKinds = (service: CapabilityName): ReadonlyArray<CapabilityName> =>
  CAPABILITY_MODULES[service].dependencies;

const dependencyId = (
  instance: PersistedServiceInstance,
  kind: CapabilityName,
): ServiceInstanceId | undefined =>
  Object.entries(instance.dependencies).find(([name]) => name === kind)?.[1];

const missingInstance = (instance: PersistedServiceInstance, dependency: CapabilityName) =>
  new InvalidStackConfigError({
    message: `${instance.service} instance ${instance.id} requires a registered ${dependency} instance`,
    capability: instance.service,
    dependency,
  });

/** Builds a plan directly from the initialized registry; every identity is registry-owned. */
export const createExecutionPlan = (
  runtime: StackRuntime,
  registry: PersistedServiceRegistry,
  modules: typeof CAPABILITY_MODULES = CAPABILITY_MODULES,
  selection?: ReadonlySet<ServiceInstanceId>,
): Effect.Effect<ExecutionPlan, InvalidStackConfigError> => {
  const byId = new Map(registry.instances.map((instance) => [instance.id, instance]));
  const instances = registry.instances;
  const registeredIds = new Set(instances.map((instance) => instance.id));
  const required = new Set<ServiceInstanceId>();
  const collectRequired = (id: ServiceInstanceId): void => {
    if (required.has(id)) return;
    required.add(id);
    const instance = byId.get(id);
    if (instance !== undefined)
      for (const dependency of Object.values(instance.dependencies)) collectRequired(dependency);
  };
  if (selection === undefined) for (const instance of instances) collectRequired(instance.id);
  else for (const id of selection) collectRequired(id);
  const dependencies: Record<ServiceInstanceId, ReadonlyArray<ServiceInstanceId>> = {};

  for (const instance of instances) {
    const ids: ServiceInstanceId[] = [];
    for (const kind of dependencyKinds(instance.service)) {
      const id = dependencyId(instance, kind);
      if (id === undefined) {
        if (required.has(instance.id)) return Effect.fail(missingInstance(instance, kind));
        continue;
      }
      const dependency = byId.get(id);
      if (dependency === undefined || dependency.service !== kind) {
        if (required.has(instance.id)) return Effect.fail(missingInstance(instance, kind));
        continue;
      }
      ids.push(id);
    }
    dependencies[instance.id] = ids;
  }

  const startOrder: ServiceInstanceId[] = [];
  const visited = new Set<ServiceInstanceId>();
  const visiting = new Set<ServiceInstanceId>();
  let serviceGraphError: InvalidStackConfigError | undefined;
  const visit = (id: ServiceInstanceId): void => {
    if (serviceGraphError !== undefined) return;
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const instance = byId.get(id);
      serviceGraphError = new InvalidStackConfigError({
        message: `Service dependency cycle detected at ${id}`,
        capability: instance?.service,
      });
      return;
    }
    visiting.add(id);
    for (const dependency of dependencies[id] ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    startOrder.push(id);
  };
  if (selection === undefined) for (const instance of instances) visit(instance.id);
  else for (const id of selection) visit(id);
  if (serviceGraphError !== undefined) return Effect.fail(serviceGraphError);

  const activation: Record<ServiceInstanceId, "eager" | "lazy"> = {};
  const routableInstances = instances.filter(hasOwnedRuntime);
  const ownedRuntimeById = new Set(routableInstances.map((instance) => instance.id));
  const routes = routableInstances.flatMap((instance) => {
    activation[instance.id] = instance.config.activation;
    return modules[instance.service].routes.map((route) => ({
      instanceId: instance.id,
      capability: instance.service,
      ...route,
    }));
  });
  const declared: PlannedWorkload[] = [];
  for (const instance of instances.filter(hasOwnedRuntime)) {
    const release = modules[instance.service].releases[instance.config.version];
    if (release === undefined)
      return Effect.fail(
        new InvalidStackConfigError({
          message: `Missing ${instance.service} release ${instance.config.version}`,
          capability: instance.service,
          version: instance.config.version,
        }),
      );
    for (const entry of selectedWorkloadsForInstance(instance, modules, release.workloads)) {
      const recipeId = `${instance.service}:${entry.name}`;
      const dependenciesForWorkload: string[] = [];
      for (const dependency of entry.dependencies) {
        const separator = dependency.indexOf(":");
        const candidate = separator < 0 ? instance.service : dependency.slice(0, separator);
        const kind = CAPABILITY_NAMES.find((name) => name === candidate);
        if (kind === undefined)
          return Effect.fail(
            new InvalidStackConfigError({
              message: `Unknown workload dependency capability ${candidate}`,
              capability: instance.service,
              workload: dependency,
            }),
          );
        const recipe = separator < 0 ? dependency : dependency.slice(separator + 1);
        const targetId = kind === instance.service ? instance.id : dependencyId(instance, kind);
        if (targetId === undefined || !registeredIds.has(targetId)) {
          if (required.has(instance.id)) return Effect.fail(missingInstance(instance, kind));
          continue;
        }
        // A stopped or disabled prerequisite remains in the service graph. Its
        // absent workload is handled by activation preflight, so the neutral
        // plan can still be used for unrelated teardown and inspection.
        if (!ownedRuntimeById.has(targetId)) continue;
        dependenciesForWorkload.push(`${targetId}:${recipe}`);
      }
      declared.push({
        id: `${instance.id}:${entry.name}`,
        instanceId: instance.id,
        recipeId,
        capability: instance.service,
        ...(entry.bootstrap === undefined ? {} : { bootstrap: entry.bootstrap }),
        dependencies: dependenciesForWorkload,
        readiness: entry.readiness,
        artifacts: entry.artifacts,
        selected: runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
      });
    }
  }
  const byWorkload = new Map(declared.map((entry) => [entry.id, entry]));
  const workloadOrder: PlannedWorkload[] = [];
  const visitingWorkloads = new Set<string>();
  const visitedWorkloads = new Set<string>();
  let workloadGraphError: InvalidStackConfigError | undefined;
  const visitWorkload = (id: string): void => {
    if (workloadGraphError !== undefined) return;
    if (visitedWorkloads.has(id)) return;
    if (visitingWorkloads.has(id)) {
      workloadGraphError = new InvalidStackConfigError({
        message: `Workload dependency cycle detected at ${id}`,
        workload: id,
      });
      return;
    }
    const entry = byWorkload.get(id);
    if (entry === undefined) {
      workloadGraphError = new InvalidStackConfigError({
        message: `Missing private workload dependency ${id}`,
        workload: id,
      });
      return;
    }
    visitingWorkloads.add(id);
    for (const dependency of entry.dependencies) visitWorkload(dependency);
    visitingWorkloads.delete(id);
    visitedWorkloads.add(id);
    workloadOrder.push(entry);
  };
  const workloadRoots =
    selection === undefined ? declared : declared.filter((entry) => required.has(entry.instanceId));
  for (const entry of workloadRoots) visitWorkload(entry.id);
  if (workloadGraphError !== undefined) return Effect.fail(workloadGraphError);
  return Effect.succeed({
    runtime,
    activation,
    startOrder,
    dependencies,
    routes,
    workloads: workloadOrder,
  });
};

export interface MaterializedCapability<Settings> {
  readonly enabled: boolean;
  readonly activation: "eager" | "lazy";
  readonly idleTimeoutSeconds: number | false;
  readonly version: string;
  readonly settings: MaterializedSettings<Settings>;
}
export interface MaterializedCapabilities {
  readonly database: MaterializedCapability<DatabaseSettings>;
  readonly rest: MaterializedCapability<RestSettings>;
  readonly auth: MaterializedCapability<AuthSettings>;
  readonly realtime: MaterializedCapability<RealtimeSettings>;
  readonly storage: MaterializedCapability<StorageSettings>;
  readonly functions: MaterializedCapability<FunctionsSettings>;
  readonly studio: MaterializedCapability<StudioSettings>;
  readonly mail: MaterializedCapability<MailSettings>;
  readonly analytics: MaterializedCapability<AnalyticsSettings>;
  readonly pooler: MaterializedCapability<PoolerSettings>;
}
