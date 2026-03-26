import { Data, Schema } from "effect";
import type { ServiceState as RawServiceState } from "@supabase/process-compose";

export const StackServiceStatusSchema = Schema.Union([
  Schema.Literal("Pending"),
  Schema.Literal("Starting"),
  Schema.Literal("Running"),
  Schema.Literal("Healthy"),
  Schema.Literal("Unhealthy"),
  Schema.Literal("Stopping"),
  Schema.Literal("Stopped"),
  Schema.Literal("Failed"),
  Schema.Literal("Restarting"),
  Schema.Literal("Initializing"),
]);

export type StackServiceStatus = typeof StackServiceStatusSchema.Type;

export class StackServiceState extends Data.Class<{
  readonly name: string;
  readonly status: StackServiceStatus;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly restartCount: number;
  readonly startedAt: number | null;
  readonly error: string | null;
}> {}

export function fromRawServiceState(raw: RawServiceState): StackServiceState {
  return new StackServiceState({
    name: raw.name,
    status: raw.status,
    pid: raw.pid,
    exitCode: raw.exitCode,
    restartCount: raw.restartCount,
    startedAt: raw.startedAt,
    error: raw.error,
  });
}
