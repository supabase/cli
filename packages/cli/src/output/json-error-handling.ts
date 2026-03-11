import { Effect } from "effect";
import { Output } from "./output.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";

export const withJsonErrorHandling = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, E, R | Output | ProcessControl> =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const output = yield* Output;
        const processControl = yield* ProcessControl;
        const objectError = typeof error === "object" && error !== null ? error : undefined;
        if (output.format === "text") return yield* Effect.fail(error);
        yield* output.fail({
          code:
            objectError !== undefined && "_tag" in objectError
              ? String(objectError._tag)
              : "UnknownError",
          message:
            objectError !== undefined && "message" in objectError
              ? String(objectError.message)
              : "Unknown error",
          ...(objectError !== undefined && "detail" in objectError
            ? { detail: String(objectError.detail) }
            : {}),
          ...(objectError !== undefined && "suggestion" in objectError
            ? { suggestion: String(objectError.suggestion) }
            : {}),
        });
        yield* processControl.setExitCode(1);
      }),
    ),
  );
