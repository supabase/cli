import { Crypto, Effect, Layer } from "effect";
import { CommandRuntime } from "./command-runtime.service.ts";

export const commandRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.effect(
    CommandRuntime,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      return CommandRuntime.of({
        commandPath: [...commandPath],
        // Correlation ID generation has no recoverable command-domain failure,
        // matching the previous ambient crypto behavior at this boundary.
        commandRunId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
      });
    }),
  );
