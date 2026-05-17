import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyFunctionsNew } from "./new.handler.ts";
import type { LegacyFunctionsNewFlags } from "./new.command.ts";

function mockGoProxy() {
  const calls: string[][] = [];
  return {
    layer: Layer.succeed(LegacyGoProxy, {
      exec: (args: ReadonlyArray<string>) =>
        Effect.sync(() => {
          calls.push([...args]);
        }),
    }),
    get calls() {
      return calls;
    },
  };
}

describe("legacyFunctionsNew", () => {
  it.live("forwards the function name and default auth mode to the Go proxy", () => {
    const proxy = mockGoProxy();
    const flags: LegacyFunctionsNewFlags = { functionName: "my-func", auth: "apikey" };

    return Effect.gen(function* () {
      yield* legacyFunctionsNew(flags);
      expect(proxy.calls).toEqual([["functions", "new", "--auth", "apikey", "my-func"]]);
    }).pipe(Effect.provide(proxy.layer));
  });

  it.live("passes --auth none when the none mode is selected", () => {
    const proxy = mockGoProxy();
    const flags: LegacyFunctionsNewFlags = { functionName: "open-func", auth: "none" };

    return Effect.gen(function* () {
      yield* legacyFunctionsNew(flags);
      expect(proxy.calls).toEqual([["functions", "new", "--auth", "none", "open-func"]]);
    }).pipe(Effect.provide(proxy.layer));
  });

  it.live("passes --auth user when the user mode is selected", () => {
    const proxy = mockGoProxy();
    const flags: LegacyFunctionsNewFlags = { functionName: "user-func", auth: "user" };

    return Effect.gen(function* () {
      yield* legacyFunctionsNew(flags);
      expect(proxy.calls).toEqual([["functions", "new", "--auth", "user", "user-func"]]);
    }).pipe(Effect.provide(proxy.layer));
  });
});
