import type { HealthCheckConfig } from "@supabase/process-compose";

type HealthBudget = Pick<
  HealthCheckConfig,
  "initialDelaySeconds" | "periodSeconds" | "startupFailureThreshold" | "failureThreshold"
>;

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
