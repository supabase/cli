import { Crypto, Effect, Layer } from "effect";
import { CommandRuntime } from "./command-runtime.service.ts";

export const commandRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.effect(
    CommandRuntime,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      return CommandRuntime.of({
        commandPath: [...commandPath],
        commandRunId: yield* crypto.randomUUIDv4,
      });
    }),
  );
