import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { commandRuntimeLayer } from "./command-runtime.layer.ts";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
  getCommandRuntimeSpanName,
} from "./command-runtime.service.ts";

describe("commandRuntimeLayer", () => {
  const testLayer = (commandPath: ReadonlyArray<string>) =>
    commandRuntimeLayer(commandPath).pipe(Layer.provide(BunServices.layer));

  it.effect("generates UUID-shaped run ids with full entropy", () =>
    Effect.gen(function* () {
      const runtime = yield* CommandRuntime;

      expect(runtime.commandRunId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }).pipe(Effect.provide(testLayer(["status"]))),
  );

  it.effect("generates a fresh command run id for each invocation", () =>
    Effect.gen(function* () {
      const first = yield* CommandRuntime.pipe(Effect.provide(testLayer(["status"])));
      const second = yield* CommandRuntime.pipe(Effect.provide(testLayer(["status"])));

      expect(first.commandPath).toEqual(["status"]);
      expect(second.commandPath).toEqual(["status"]);
      expect(getCommandRuntimeCommand(first)).toBe("status");
      expect(getCommandRuntimeSpanName(first)).toBe("command.status");
      expect(first.commandRunId).not.toBe(second.commandRunId);
    }),
  );
});
