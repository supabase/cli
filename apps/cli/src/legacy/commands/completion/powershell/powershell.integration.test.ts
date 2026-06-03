import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyCompletionPowershell } from "./powershell.handler.ts";

function setupLegacyCompletionPowershell() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push(args);
      }),
  });
  return { layer, calls };
}

describe("legacy completion powershell", () => {
  it.live("forwards `completion powershell` to the Go binary", () => {
    const { layer, calls } = setupLegacyCompletionPowershell();
    return Effect.gen(function* () {
      yield* legacyCompletionPowershell({});
      expect(calls).toEqual([["completion", "powershell"]]);
    }).pipe(Effect.provide(layer));
  });
});
