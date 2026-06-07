import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { commandRuntimeLayer } from "./command-runtime.layer.ts";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
  getCommandRuntimeSpanName,
} from "./command-runtime.service.ts";

describe("commandRuntimeLayer", () => {
  it.effect("generates a fresh command run id for each invocation", () =>
    Effect.gen(function* () {
      const first = yield* Effect.gen(function* () {
        return yield* CommandRuntime;
      }).pipe(Effect.provide(commandRuntimeLayer(["status"])));
      const second = yield* Effect.gen(function* () {
        return yield* CommandRuntime;
      }).pipe(Effect.provide(commandRuntimeLayer(["status"])));

      expect(first.commandPath).toEqual(["status"]);
      expect(second.commandPath).toEqual(["status"]);
      expect(getCommandRuntimeCommand(first)).toBe("status");
      expect(getCommandRuntimeSpanName(first)).toBe("command.status");
      expect(first.commandRunId).not.toBe(second.commandRunId);
    }),
  );
});
