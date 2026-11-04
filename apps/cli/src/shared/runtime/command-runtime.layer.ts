import { Effect, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import { CommandRuntime } from "./command-runtime.service.ts";

export const commandRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.effect(
    CommandRuntime,
    Effect.gen(function* () {
      const crypto = yield* SecureRandom.SecureRandom;
      return CommandRuntime.of({
        commandPath: [...commandPath],
        commandRunId: yield* crypto.uuidV4(),
      });
    }),
  );
