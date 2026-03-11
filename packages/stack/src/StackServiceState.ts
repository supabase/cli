import { Data } from "effect";
import type { ServiceState as RawServiceState } from "@supabase/process-compose";

export type StackServiceStatus = RawServiceState["status"] | "Initializing";

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
