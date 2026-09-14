import { Data, Effect } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
} from "../shared/runtime/command-runtime.service.ts";

/**
 * A tombstoned command path or a rejected removed flag. The caller supplies its own
 * replacement suggestion; there is no closed vocabulary for it since removal
 * suggestions vary per surface.
 */
export class RemovedSurfaceError extends Data.TaggedError("RemovedSurfaceError")<{
  readonly message: string;
  readonly suggestion: string;
  readonly kind: "command" | "flag";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return {
      ...actionability.removedSurface,
      fingerprint_suffix: this.kind === "flag" ? "removed_flag" : "removed_command",
    };
  }
}

/**
 * Fails with a `RemovedSurfaceError` naming the invoked command path. The caller wraps the
 * returned effect in `withCommandTelemetry()` then `withJsonErrorHandling`, matching
 * `commit.command.ts`'s composition order, and provides a `CommandRuntime` layer for its path.
 */
export const removedCommand = (suggestion: string) =>
  Effect.gen(function* () {
    const commandRuntime = yield* CommandRuntime;
    const command = getCommandRuntimeCommand(commandRuntime);
    return yield* Effect.fail(
      new RemovedSurfaceError({
        message: `supabase ${command} was removed.`,
        suggestion,
        kind: "command",
      }),
    );
  });

/**
 * Fails with a `RemovedSurfaceError` for a removed flag on an otherwise-native command. The host
 * command already wraps its whole handler in `withCommandTelemetry`, so this is a bare effect.
 */
export const removedFlag = (flag: string, suggestion: string) =>
  Effect.fail(
    new RemovedSurfaceError({ message: `${flag} was removed.`, suggestion, kind: "flag" }),
  );
