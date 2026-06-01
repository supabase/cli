import { Effect, Layer } from "effect";

import { textOutputLayer } from "../../shared/output/output.layer.ts";
import { Output } from "../../shared/output/output.service.ts";

/**
 * Legacy wrapper over the shared text output layer for Go machine-format
 * requests (`-o json|yaml|toml|env`).
 *
 * Go's `--output` selects a machine encoder that the handler writes via
 * `output.raw`. If the text layer stays fully active, its progress spinner
 * writes ANSI escape sequences to stdout and corrupts that payload — see
 * CLI-1546, where `branches list -o json` emitted a hide-cursor sequence ahead
 * of the JSON and broke `JSON.parse`.
 *
 * This layer suppresses ONLY the transient progress UI (`task`/`progress`).
 * Everything else (errors -> red text on stderr, `raw`, logs, `format: "text"`)
 * delegates to the text layer unchanged, so Go output parity is preserved
 * exactly while stdout stays parseable.
 */
export const legacyQuietProgressTextOutputLayer = Layer.effect(
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
