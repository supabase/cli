import { Effect, Layer } from "effect";

import { textOutputLayer } from "../shared/output/output.layer.ts";
import { Output } from "../shared/output/output.service.ts";

/**
 * Wrapper over the shared text output layer for the machine-format flag (`-o
 * json|yaml|toml|env`) that suppresses only the transient progress UI (`task`/`progress`),
 * since a live spinner would write ANSI escapes to stdout and corrupt the machine payload the
 * handler writes via `output.raw`. Everything else delegates to the text layer unchanged, so
 * output stays byte-identical while stdout stays parseable.
 */
export const quietProgressTextOutputLayer = Layer.effect(
  Output,
  Effect.gen(function* () {
    const base = yield* Output;
    return Output.of({
      ...base,
      task: () =>
        Effect.succeed({
          message: () => Effect.void,
          succeed: () => Effect.void,
          fail: () => Effect.void,
          info: () => Effect.void,
          cancel: () => Effect.void,
          clear: () => Effect.void,
        }),
      progress: () =>
        Effect.succeed({
          start: () => Effect.void,
          advance: () => Effect.void,
          message: () => Effect.void,
          stop: () => Effect.void,
        }),
    });
  }),
).pipe(Layer.provide(textOutputLayer));
