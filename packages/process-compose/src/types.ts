// Configuration types (parsed from YAML)

export interface ProjectConfig {
  version: string;
  name: string;
  log_location?: string;
  processes: Record<string, ProcessConfig>;
}

export interface ProcessConfig {
  command: string;
  environment?: string[];
  depends_on?: Record<string, DependencyConfig>;
  readiness_probe?: ProbeConfig;
  shutdown?: ShutdownConfig;
  availability?: AvailabilityConfig;
}

export interface DependencyConfig {
  condition:
    | "process_started"
    | "process_healthy"
    | "process_completed"
    | "process_completed_successfully";
}

export interface ProbeConfig {
  exec?: ExecProbeConfig;
  http_get?: HttpProbeConfig;
  initial_delay_seconds?: number;
  period_seconds?: number;
  timeout_seconds?: number;
  success_threshold?: number;
  failure_threshold?: number;
}

export interface ExecProbeConfig {
  command: string;
}

export interface HttpProbeConfig {
  host: string;
  port: number | string;
  path: string;
  scheme: "http" | "https";
}

export interface ShutdownConfig {
  signal: number;
  timeout_seconds?: number;
}

export interface AvailabilityConfig {
  restart: "no" | "always" | "on_failure" | "exit_on_failure";
  backoff_seconds?: number;
  max_restarts?: number;
}

// Runtime types

export type ProcessStatus =
  | "Pending"
  | "Launching"
  | "Running"
  | "Ready"
  | "Restarting"
  | "Terminating"
  | "Completed"
  | "Error"
  | "Disabled";

export type HealthStatus = "Unknown" | "Ready" | "Not Ready";

export interface ProcessState {
  name: string;
  status: ProcessStatus;
  health: HealthStatus;
  hasHealthProbe: boolean;
  restarts: number;
  exitCode: number;
  pid: number;
  isRunning: boolean;
  startedAt?: number;
  age: number;
}

export interface ProcessesState {
  data: ProcessState[];
}

export interface LogsResponse {
  logs: string[];
}

// Events

export type ProcessEvent =
  | { type: "started"; pid: number }
  | { type: "healthy" }
  | { type: "unhealthy" }
  | { type: "exited"; code: number }
  | { type: "error"; error: Error };
