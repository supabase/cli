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
    execCapture: () => Effect.succeed(""),
  });
  return { layer, calls };
}

describe("legacy completion zsh", () => {
  it.live("forwards `completion zsh` to the Go binary", () => {
    const { layer, calls } = setupLegacyCompletionZsh();
    return Effect.gen(function* () {
      yield* legacyCompletionZsh({ noDescriptions: false });
      expect(calls).toEqual([["completion", "zsh"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --no-descriptions when set", () => {
    const { layer, calls } = setupLegacyCompletionZsh();
    return Effect.gen(function* () {
      yield* legacyCompletionZsh({ noDescriptions: true });
      expect(calls).toEqual([["completion", "zsh", "--no-descriptions"]]);
    }).pipe(Effect.provide(layer));
  });
});
