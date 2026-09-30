import { describe, expect, it } from "@effect/vitest";
import { BunCrypto } from "@effect/platform-bun";
import { Effect } from "effect";

import { commandRuntimeLayer } from "./command-runtime.layer.ts";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
  getCommandRuntimeSpanName,
} from "./command-runtime.service.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("commandRuntimeLayer", () => {
  it.effect("generates a fresh command run id for each invocation", () =>
    Effect.gen(function* () {
      const first = yield* CommandRuntime.pipe(Effect.provide(commandRuntimeLayer(["status"])));
      const second = yield* CommandRuntime.pipe(Effect.provide(commandRuntimeLayer(["status"])));

      expect(first.commandPath).toEqual(["status"]);
      expect(second.commandPath).toEqual(["status"]);
      expect(getCommandRuntimeCommand(first)).toBe("status");
      expect(getCommandRuntimeSpanName(first)).toBe("command.status");
      expect(first.commandRunId).toMatch(UUID_V4);
      expect(second.commandRunId).toMatch(UUID_V4);
      expect(first.commandRunId).not.toBe(second.commandRunId);
    }).pipe(Effect.provide(BunCrypto.layer)),
  );
});
