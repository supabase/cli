export type {
  DependencyCondition,
  Dependency,
  ExternalCleanupAction,
  ProbeConfig,
  HealthCheckConfig,
  ShutdownConfig,
  RestartPolicy,
  SupervisionConfig,
  HookTrigger,
  HookLog,
  LifecycleHook,
  OrchestratorConfig,
  ServiceDef,
} from "./ServiceDef.ts";
export { defaults } from "./ServiceDef.ts";

export type { ServiceStatus } from "./ServiceState.ts";
export { ServiceState, initial } from "./ServiceState.ts";

export {
  CyclicDependencyError,
  MissingDependencyError,
  ServiceNotFoundError,
  ServiceReadyError,
  SpawnError,
  ShutdownTimeoutError,
} from "./errors.ts";

export type { LogEntry } from "./LogBuffer.ts";
export { LogBuffer } from "./LogBuffer.ts";

export type { ResolvedGraph } from "./DependencyGraph.ts";
export { buildGraph } from "./DependencyGraph.ts";

export type { HealthProbeCallbacks } from "./HealthProbe.ts";
export { makeSupervisedCommand, supervisorRuntimePath, usesSupervisor } from "./Supervisor.ts";
export {
  enableSupervisorSelfDispatchForCompiledBun,
  isSupervisorRuntimeRequested,
} from "./supervisor-protocol.ts";
export { runSupervisorRuntime, runSupervisorRuntimeFromEnv } from "./supervisor-runtime.ts";

export type { ServiceEvent } from "./ServiceTransition.ts";
export { applyEvent, transition } from "./ServiceTransition.ts";

export { Orchestrator } from "./Orchestrator.ts";
