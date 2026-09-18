import {
  NATIVE_PROCESS_DISPATCH_SENTINEL,
  SUPERVISOR_DISPATCH_SENTINEL,
} from "./dispatch-markers.ts";
import { Data, Effect } from "effect";

class ProcessDispatchError extends Data.TaggedError("ProcessDispatchError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const importError = (cause: unknown) =>
  new ProcessDispatchError({
    message: "Unable to load the dispatched stack process entrypoint",
    cause,
  });

const dispatchError = (cause: unknown) =>
  new ProcessDispatchError({ message: "The dispatched stack process failed", cause });

export {
  NATIVE_PROCESS_DISPATCH_SENTINEL,
  SUPERVISOR_DISPATCH_SENTINEL,
} from "./dispatch-markers.ts";

/**
 * Supported process-entrypoint seam for embedders such as the CLI binary.
 * Returns true when the argv is the supervisor child dispatch, otherwise the
 * caller should continue with its normal command entrypoint.
 */
export const runSupervisorProcessIfDispatched = (
  argv: ReadonlyArray<string>,
): Effect.Effect<boolean, ProcessDispatchError> =>
  argv[0] !== SUPERVISOR_DISPATCH_SENTINEL
    ? Effect.succeed(false)
    : Effect.tryPromise({
        try: () => import("../entrypoints/supervisor-node.ts"),
        catch: importError,
      }).pipe(
        Effect.flatMap(({ runSupervisorProcess }) => runSupervisorProcess(argv.slice(1))),
        Effect.as(true),
      );

/**
 * Runs the embedded native launcher when a compiled CLI receives its private
 * dispatch marker. Returns false for ordinary CLI argv so callers can continue
 * with their normal command entrypoint.
 */
export const runNativeProcessIfDispatched = (
  argv: ReadonlyArray<string>,
): Effect.Effect<boolean, ProcessDispatchError> =>
  argv[0] !== NATIVE_PROCESS_DISPATCH_SENTINEL
    ? Effect.succeed(false)
    : Effect.tryPromise({
        try: () => import("../runtime/native-launcher.ts"),
        catch: importError,
      }).pipe(
        Effect.flatMap(({ runNativeLauncher }) =>
          Effect.try({ try: runNativeLauncher, catch: dispatchError }),
        ),
        Effect.as(true),
      );
