import { Data } from "effect";

export type ServiceStatus =
  | "Pending"
  | "Starting"
  | "Running"
  | "Healthy"
  | "Unhealthy"
  | "Stopping"
  | "Stopped"
  | "Failed"
  | "Restarting";

export type ServiceDesiredState = "inactive" | "running" | "stopped";

export class ServiceState extends Data.Class<{
  readonly name: string;
  readonly status: ServiceStatus;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly restartCount: number;
  readonly startedAt: number | null;
  readonly error: string | null;
  /** Caller-owned intent, independent of the current process transition. */
  readonly desired: ServiceDesiredState;
}> {}

export const initial = (name: string, desired: ServiceDesiredState = "inactive"): ServiceState =>
  new ServiceState({
    name,
    status: "Pending",
    pid: null,
    exitCode: null,
    restartCount: 0,
    startedAt: null,
    error: null,
    desired,
  });
