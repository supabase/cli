import type { ServiceName } from "../ServiceName.ts";

export interface HealthBudget {
  readonly initialDelaySeconds: number;
  readonly periodSeconds: number;
  readonly startupFailureThreshold: number;
  readonly failureThreshold: number;
}

/**
 * Converts a startup scheduling budget to a probe threshold while retaining
 * the factory's liveness policy. An explicit budget also caps the initial
 * delay, so zero means one immediate probe. The supervisory transition may
 * still overshoot by the duration of the final probe itself; the probe timeout
 * remains an independent generic health-check setting.
 */
export function withStartupHealthTimeout(
  budget: HealthBudget,
  timeoutMs: number | undefined,
): HealthBudget {
  if (timeoutMs === undefined) {
    return budget;
  }

  const normalizedTimeoutMs = Math.max(0, timeoutMs);
  const initialDelaySeconds = Math.min(budget.initialDelaySeconds, normalizedTimeoutMs / 1_000);
  const probeWindowMs = Math.max(0, normalizedTimeoutMs - initialDelaySeconds * 1_000);
  return {
    ...budget,
    initialDelaySeconds,
    startupFailureThreshold: Math.max(1, Math.ceil(probeWindowMs / (budget.periodSeconds * 1_000))),
  };
}

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

export const healthStartupBudgetSeconds = (budget: HealthBudget): number =>
  budget.initialDelaySeconds + budget.periodSeconds * budget.startupFailureThreshold;

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

export const dependencyTimeoutSecondsForService = (service: ServiceName): number =>
  stackServiceStartupBudgetSeconds[service] + STARTUP_COORDINATION_MARGIN_SECONDS;
