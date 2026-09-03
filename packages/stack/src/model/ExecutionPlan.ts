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
import type {
  WorkloadSpec,
  NativeArtifact,
  ContainerArtifact,
  MaterializedSettings,
} from "./CapabilityModule.ts";
import { Effect } from "effect";
import { InvalidStackConfigError } from "../public/Errors.ts";
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
  readonly artifacts: Readonly<{
    readonly native: NativeArtifact;
    readonly container: ContainerArtifact;
  }>;
  readonly selected: NativeArtifact | ContainerArtifact;
}

export interface ExecutionPlan {
  readonly runtime: StackRuntime;
  /** Materialized lazy/eager policy consumed by the Supervisor gateway seam. */
  readonly activation: Readonly<{ [Name in CapabilityName]: EnabledCapability["activation"] }>;
  readonly startOrder: ReadonlyArray<CapabilityName>;
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

export const eagerCapabilities = (plan: ExecutionPlan): Set<CapabilityName> => {
  const active = new Set<CapabilityName>();
  const visit = (name: CapabilityName): void => {
    if (active.has(name)) return;
    active.add(name);
    for (const dependency of plan.dependencies[name]) visit(dependency);
  };
  for (const name of CAPABILITY_NAMES) if (plan.activation[name] === "eager") visit(name);
  return active;
};

export const activeExecutionPlan = (
  plan: ExecutionPlan,
  active: ReadonlySet<CapabilityName>,
): ExecutionPlan => ({
  ...plan,
  workloads: plan.workloads.filter((workload) => active.has(workload.capability)),
  startOrder: plan.startOrder.filter((name) => active.has(name)),
});

export interface EnabledCapability {
  readonly enabled: boolean;
  readonly activation: "eager" | "lazy";
}

type PlanSettings = {
  readonly database: MaterializedSettings<DatabaseSettings>;
  readonly rest: MaterializedSettings<RestSettings>;
  readonly auth: MaterializedSettings<AuthSettings>;
  readonly realtime: MaterializedSettings<RealtimeSettings>;
  readonly storage: MaterializedSettings<StorageSettings>;
  readonly functions: MaterializedSettings<FunctionsSettings>;
  readonly studio: MaterializedSettings<StudioSettings>;
  readonly mail: MaterializedSettings<MailSettings>;
  readonly analytics: MaterializedSettings<AnalyticsSettings>;
  readonly pooler: MaterializedSettings<PoolerSettings>;
};

const selectedWorkloads = (
  name: CapabilityName,
  modules: typeof CAPABILITY_MODULES,
  settings: PlanSettings,
  workloads: ReadonlyArray<WorkloadSpec>,
): ReadonlyArray<WorkloadSpec> => {
  switch (name) {
    case "database":
      return modules.database.selectWorkloads?.(settings.database, workloads) ?? workloads;
    case "rest":
      return modules.rest.selectWorkloads?.(settings.rest, workloads) ?? workloads;
    case "auth":
      return modules.auth.selectWorkloads?.(settings.auth, workloads) ?? workloads;
    case "realtime":
      return modules.realtime.selectWorkloads?.(settings.realtime, workloads) ?? workloads;
    case "storage":
      return modules.storage.selectWorkloads?.(settings.storage, workloads) ?? workloads;
    case "functions":
      return modules.functions.selectWorkloads?.(settings.functions, workloads) ?? workloads;
    case "studio":
      return modules.studio.selectWorkloads?.(settings.studio, workloads) ?? workloads;
    case "mail":
      return modules.mail.selectWorkloads?.(settings.mail, workloads) ?? workloads;
    case "analytics":
      return modules.analytics.selectWorkloads?.(settings.analytics, workloads) ?? workloads;
    case "pooler":
      return modules.pooler.selectWorkloads?.(settings.pooler, workloads) ?? workloads;
  }
};

export const createExecutionPlan = (
  runtime: StackRuntime,
  enabled: Readonly<{ [Name in CapabilityName]: EnabledCapability }>,
  versions: Readonly<{ [Name in CapabilityName]: string }>,
  settings: PlanSettings,
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
  const routes = CAPABILITY_NAMES.flatMap((name) =>
    enabled[name].enabled
      ? modules[name].routes.map((route) => ({ capability: name, ...route }))
      : [],
  );
  const declaredWorkloads: PlannedWorkload[] = [];
  for (const name of CAPABILITY_NAMES) {
    if (!enabled[name].enabled) continue;
    const release = modules[name].releases[versions[name]];
    if (release === undefined)
      return Effect.fail(
        new InvalidStackConfigError({
          message: `Missing ${name} release ${versions[name]}`,
          capability: name,
          version: versions[name],
        }),
      );
    const selectedEntries = selectedWorkloads(name, modules, settings, release.workloads);
    for (const entry of selectedEntries) {
      const id = `${name}:${entry.name}`;
      declaredWorkloads.push({
        id,
        capability: name,
        ...(entry.bootstrap === undefined ? {} : { bootstrap: entry.bootstrap }),
        dependencies: entry.dependencies,
        readiness: entry.readiness,
        artifacts: entry.artifacts,
        selected: runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
      });
    }
  }
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
  const activation = {
    database: enabled.database.activation,
    rest: enabled.rest.activation,
    auth: enabled.auth.activation,
    realtime: enabled.realtime.activation,
    storage: enabled.storage.activation,
    functions: enabled.functions.activation,
    studio: enabled.studio.activation,
    mail: enabled.mail.activation,
    analytics: enabled.analytics.activation,
    pooler: enabled.pooler.activation,
  } satisfies { [Name in CapabilityName]: EnabledCapability["activation"] };
  return Effect.succeed({
    runtime,
    activation,
    startOrder: start,
    dependencies: dependencyMap,
    routes,
    workloads: workloadOrder,
  });
};
