import { Effect, Runtime } from "effect";
import { Output } from "./output.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import { normalizeCliError } from "./normalize-error.ts";

export const withJsonErrorHandling = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, E, R | Output | ProcessControl> =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const output = yield* Output;
        const processControl = yield* ProcessControl;
        if (output.format === "text") return yield* Effect.fail(error);
        yield* output.fail(normalizeCliError(error));
        // `Runtime.getErrorExitCode` defaults to 1 for any error without a
        // `[Runtime.errorExitCode]` marker, so this is a no-op for every existing
        // error type. It only changes behavior for an error that opts in — e.g.
        // `LegacyGoChildExitError` (CLI-1879), so a delegated Go child's exact exit
        // code (not just a generic 1) still reaches the user under json/stream-json,
        // matching the exit code `runCli`'s text-mode path already propagates.
        yield* processControl.setExitCode(Runtime.getErrorExitCode(error));
      }),
    ),
  );
