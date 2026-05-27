import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyCompletionZsh } from "./zsh.handler.ts";

function setupLegacyCompletionZsh() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push(args);
      }),
  });
  return { layer, calls };
}

describe("legacy completion zsh", () => {
  it.live("forwards `completion zsh` to the Go binary", () => {
    const { layer, calls } = setupLegacyCompletionZsh();
    return Effect.gen(function* () {
      yield* legacyCompletionZsh({});
      expect(calls).toEqual([["completion", "zsh"]]);
    }).pipe(Effect.provide(layer));
  });
});
