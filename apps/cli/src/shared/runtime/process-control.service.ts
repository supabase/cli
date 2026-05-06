import type { Effect, Scope } from "effect";
import { ServiceMap } from "effect";

export type CliProcessSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

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
  /**
   * Installs a no-op listener for each given signal, keeping them registered
   * for the lifetime of the surrounding scope. Disables the runtime's default
   * terminate-on-signal behavior so callers can spawn a child in the same
   * process group (detached:false) and let the child handle the signal itself
   * without the parent exiting prematurely with code 130.
   */
  readonly holdSignals: (
    signals: ReadonlyArray<CliProcessSignal>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly exit: (code: number) => Effect.Effect<never>;
  readonly setExitCode: (code: number) => Effect.Effect<void>;
  readonly getExitCode: Effect.Effect<number | undefined>;
}

/**
 * ProcessControl - Service tag for process lifecycle operations.
 */
export class ProcessControl extends ServiceMap.Service<ProcessControl, ProcessControlShape>()(
  "supabase/runtime/ProcessControl",
) {}
