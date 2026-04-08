import { Effect, Layer } from "effect";
import { CommandRuntime } from "./command-runtime.service.ts";

export const commandRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.effect(
    CommandRuntime,
    Effect.sync(() =>
      CommandRuntime.of({
        commandPath: [...commandPath],
        commandRunId: crypto.randomUUID(),
      }),
    ),
  );
