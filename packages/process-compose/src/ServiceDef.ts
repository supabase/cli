import type { Effect } from "effect";
import type { ChildProcess } from "effect/unstable/process";

export type DependencyCondition = "started" | "healthy" | "completed";

export interface Dependency {
  readonly service: string;
  readonly condition: DependencyCondition;
}

export type ProbeConfig =
  | {
      readonly _tag: "Http";
      readonly host: string;
      readonly port: number;
      readonly path: string;
      readonly scheme: "http" | "https";
    }
  | {
      readonly _tag: "Exec";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Record<string, string>;
    }
  | { readonly _tag: "Tcp"; readonly host: string; readonly port: number };

export interface HealthCheckConfig {
  readonly probe: ProbeConfig;
  readonly initialDelaySeconds?: number;
  readonly periodSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly successThreshold?: number;
  /** Consecutive failures allowed before the process has ever become healthy. */
  readonly startupFailureThreshold?: number;
  readonly failureThreshold?: number;
}

export interface ShutdownConfig {
  readonly signal?: ChildProcess.Signal;
  readonly timeoutSeconds?: number;
}

export type RestartPolicy = "no" | "on-failure" | "always" | "unless-stopped";

export type HookTrigger = "started" | "healthy";

export type HookLog = (stream: "stdout" | "stderr", line: string) => Effect.Effect<void>;

export interface LifecycleHook {
  readonly on: HookTrigger;
  readonly run: (log: HookLog) => Effect.Effect<void, Error>;
  readonly timeoutSeconds?: number;
  readonly failurePolicy?: "fail" | "ignore";
}

export type ExternalCleanupAction =
  | {
      readonly _tag: "RunCommand";
      readonly executable: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
    }
  | {
      readonly _tag: "RemovePath";
      readonly path: string;
      readonly recursive?: boolean;
      readonly force?: boolean;
    };

export interface SupervisionConfig {
  readonly orphanCleanup?: ReadonlyArray<ExternalCleanupAction>;
}

export interface ServiceDef {
  readonly name: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly dependencies?: ReadonlyArray<Dependency>;
  readonly dependencyTimeoutSeconds?: number;
  readonly healthCheck?: HealthCheckConfig;
  readonly shutdown?: ShutdownConfig;
  readonly restart?: RestartPolicy;
  readonly maxRestarts?: number;
  readonly cleanup?: Effect.Effect<void, Error>;
  readonly supervision?: SupervisionConfig;
  readonly hooks?: ReadonlyArray<LifecycleHook>;
  readonly enabled?: boolean;
}

export interface OrchestratorConfig {
  readonly shutdownTimeoutSeconds?: number;
}

export interface ServiceStartOptions {
  /** Runs when a service lifecycle starts and again after each process exit before backoff. */
  readonly beforeStart?: (name: string) => Effect.Effect<void, Error>;
  /** Runs after dependencies are satisfied and immediately before each spawn. */
  readonly beforeSpawn?: (name: string) => Effect.Effect<void>;
}

export const defaults = {
  healthCheck: {
    initialDelaySeconds: 0,
    periodSeconds: 10,
    timeoutSeconds: 2,
    successThreshold: 1,
    failureThreshold: 3,
  },
  shutdown: {
    signal: "SIGTERM" as const,
    timeoutSeconds: 10,
  },
  dependencyTimeoutSeconds: 120,
  hookTimeoutSeconds: 30,
  shutdownTimeoutSeconds: 60,
  restart: "unless-stopped" as const,
  maxRestarts: 0,
  enabled: true,
} as const;
