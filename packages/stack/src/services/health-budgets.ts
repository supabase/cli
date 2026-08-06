import { defaults, type HealthCheckConfig } from "@supabase/process-compose";
import type { ServiceName } from "../versions.ts";

type HealthBudget = Required<
  Pick<
    HealthCheckConfig,
    "initialDelaySeconds" | "periodSeconds" | "startupFailureThreshold" | "failureThreshold"
  >
> &
  Pick<HealthCheckConfig, "timeoutSeconds">;

/** Cold-start tolerance and tighter post-start liveness thresholds. */
export const stackHealthBudgets = {
  postgresNative: {
    initialDelaySeconds: 0,
    periodSeconds: 0.5,
    startupFailureThreshold: 120,
    failureThreshold: 30,
  },
  postgresDocker: {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    startupFailureThreshold: 120,
    failureThreshold: 30,
  },
  auth: {
    initialDelaySeconds: 0,
    periodSeconds: 0.5,
    startupFailureThreshold: 60,
    failureThreshold: 20,
  },
  postgrest: {
    initialDelaySeconds: 0,
    periodSeconds: 0.5,
    startupFailureThreshold: 60,
    failureThreshold: 20,
  },
  edgeRuntime: {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    startupFailureThreshold: 60,
    failureThreshold: 30,
  },
  mailpit: {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    startupFailureThreshold: 60,
    failureThreshold: 30,
  },
  realtime: {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    startupFailureThreshold: 60,
    failureThreshold: 30,
  },
  storage: {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    startupFailureThreshold: 60,
    failureThreshold: 30,
  },
  imgproxy: {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    startupFailureThreshold: 60,
    failureThreshold: 30,
  },
  pgmeta: {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    startupFailureThreshold: 60,
    failureThreshold: 30,
  },
  analytics: {
    initialDelaySeconds: 10,
    periodSeconds: 1,
    startupFailureThreshold: 120,
    failureThreshold: 60,
  },
  vector: {
    initialDelaySeconds: 1,
    periodSeconds: 1,
    startupFailureThreshold: 60,
    failureThreshold: 30,
  },
  pooler: {
    initialDelaySeconds: 2,
    periodSeconds: 1,
    startupFailureThreshold: 90,
    failureThreshold: 60,
  },
  studio: {
    initialDelaySeconds: 2,
    periodSeconds: 1,
    startupFailureThreshold: 90,
    failureThreshold: 60,
  },
} as const satisfies Record<string, HealthBudget>;

export const healthStartupBudgetSeconds = (budget: HealthBudget): number => {
  const attempts = budget.startupFailureThreshold;
  const probeTimeoutSeconds = budget.timeoutSeconds ?? defaults.healthCheck.timeoutSeconds;
  return (
    budget.initialDelaySeconds +
    attempts * probeTimeoutSeconds +
    (attempts - 1) * budget.periodSeconds
  );
};

/** Worst-case initial health budget for each public service. */
export const stackServiceStartupBudgetSeconds = {
  postgres: Math.max(
    healthStartupBudgetSeconds(stackHealthBudgets.postgresNative),
    healthStartupBudgetSeconds(stackHealthBudgets.postgresDocker),
  ),
  postgrest: healthStartupBudgetSeconds(stackHealthBudgets.postgrest),
  auth: healthStartupBudgetSeconds(stackHealthBudgets.auth),
  "edge-runtime": healthStartupBudgetSeconds(stackHealthBudgets.edgeRuntime),
  realtime: healthStartupBudgetSeconds(stackHealthBudgets.realtime),
  storage: healthStartupBudgetSeconds(stackHealthBudgets.storage),
  imgproxy: healthStartupBudgetSeconds(stackHealthBudgets.imgproxy),
  mailpit: healthStartupBudgetSeconds(stackHealthBudgets.mailpit),
  pgmeta: healthStartupBudgetSeconds(stackHealthBudgets.pgmeta),
  studio: healthStartupBudgetSeconds(stackHealthBudgets.studio),
  analytics: healthStartupBudgetSeconds(stackHealthBudgets.analytics),
  vector: healthStartupBudgetSeconds(stackHealthBudgets.vector),
  pooler: healthStartupBudgetSeconds(stackHealthBudgets.pooler),
} as const satisfies Readonly<Record<ServiceName, number>>;

const STARTUP_COORDINATION_MARGIN_SECONDS = 5;

export const dependencyTimeoutSecondsForServices = (services: ReadonlyArray<ServiceName>): number =>
  services.reduce((total, service) => total + stackServiceStartupBudgetSeconds[service], 0) +
  STARTUP_COORDINATION_MARGIN_SECONDS;
