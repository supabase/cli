import type { Effect } from "effect";
import { ServiceMap } from "effect";

export type CliProcessSignal = "SIGINT" | "SIGTERM";

/**
 * ProcessControl - Boundary around process lifecycle operations.
 *
 * Commands depend on this service instead of calling `process` directly so
 * signal handling, shutdown behavior, and exit semantics stay mockable in tests.
 */
interface ProcessControlShape {
  readonly awaitSignal: (
    signals?: ReadonlyArray<CliProcessSignal>,
  ) => Effect.Effect<CliProcessSignal>;
  readonly awaitShutdown: Effect.Effect<void>;
  readonly exit: (code: number) => Effect.Effect<never>;
  readonly setExitCode: (code: number) => Effect.Effect<void>;
}

/**
 * ProcessControl - Service tag for process lifecycle operations.
 */
export class ProcessControl extends ServiceMap.Service<ProcessControl, ProcessControlShape>()(
  "@supabase/cli/runtime/ProcessControl",
) {}
