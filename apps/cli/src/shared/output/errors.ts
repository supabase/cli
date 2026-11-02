import { Cause, Data, Effect, Runtime } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/**
 * Message used for declined-confirmation cancellation errors. The text
 * `Output.fail` renderer matches this exact string (after
 * `normalizeCliError`'s trimming) to suppress the `--debug` hint, since
 * declining a prompt is a user decision, not something worth troubleshooting.
 *
 * The match is exact, not prefix/substring — widen it if a wrapped
 * cancellation message (e.g. `"...: context canceled"`) ever needs the same
 * treatment.
 */
export const CONTEXT_CANCELED_MESSAGE = "context canceled";

export class NonInteractiveError extends Data.TaggedError("NonInteractiveError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return `${this.detail}\n  Suggestion: ${this.suggestion}`;
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The process reading stdout closed it, for example `supabase … | head`. It ends the command
 * through its finalizers and exits 0, the way a Unix tool stops on a broken pipe.
 */
export class StdoutClosedError extends Data.TaggedError("StdoutClosedError") {
  override readonly [Runtime.errorExitCode] = 0;

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

/**
 * The failures a run still has to report once a closed stdout is set aside, or `undefined` when
 * the closed stdout, and the interruptions it caused, are all that ended the run.
 */
export const failureBesideClosedStdout = <E>(cause: Cause.Cause<E>): Cause.Cause<E> | undefined => {
  const isClosedStdout = (reason: Cause.Reason<E>) =>
    Cause.isDieReason(reason) && reason.defect instanceof StdoutClosedError;
  if (!cause.reasons.some(isClosedStdout)) return cause;
  const remaining = cause.reasons.filter((reason) => !isClosedStdout(reason));
  return remaining.every(Cause.isInterruptReason) ? undefined : Cause.fromReasons(remaining);
};

/** Lets a final message to a closed stdout be dropped, so it cannot replace the outcome it reports. */
export const ignoreStdoutClosed = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, E, R> =>
  effect.pipe(
    Effect.catchDefect((defect) =>
      defect instanceof StdoutClosedError ? Effect.void : Effect.die(defect),
    ),
  );
