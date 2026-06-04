import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyCompletionBash } from "./bash.handler.ts";

function setupLegacyCompletionBash() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push(args);
      }),
  });
  return { layer, calls };
}

describe("legacy completion bash", () => {
  it.live("forwards `completion bash` to the Go binary", () => {
    const { layer, calls } = setupLegacyCompletionBash();
    return Effect.gen(function* () {
      yield* legacyCompletionBash({});
      expect(calls).toEqual([["completion", "bash"]]);
    }).pipe(Effect.provide(layer));
  });
});
