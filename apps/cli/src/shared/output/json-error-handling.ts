import { Effect } from "effect";
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
        yield* processControl.setExitCode(1);
      }),
    ),
  );
