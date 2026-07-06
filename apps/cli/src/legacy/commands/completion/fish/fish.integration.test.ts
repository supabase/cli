import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyCompletionFishCommand } from "./fish.command.ts";
import { legacyCompletionFish } from "./fish.handler.ts";

function setupLegacyCompletionFish() {
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

function legacyTestRoot() {
  return Command.make("supabase").pipe(Command.withSubcommands([legacyCompletionFishCommand]));
}

describe("legacy completion fish", () => {
  it.live("forwards `completion fish` to the Go binary", () => {
    const { layer, calls } = setupLegacyCompletionFish();
    return Effect.gen(function* () {
      yield* legacyCompletionFish({ noDescriptions: false });
      expect(calls).toEqual([["completion", "fish"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --no-descriptions when set", () => {
    const { layer, calls } = setupLegacyCompletionFish();
    return Effect.gen(function* () {
      yield* legacyCompletionFish({ noDescriptions: true });
      expect(calls).toEqual([["completion", "fish", "--no-descriptions"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts --no-descriptions from real argv via the command parser", () => {
    const { layer, calls } = setupLegacyCompletionFish();
    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
        "fish",
        "--no-descriptions",
      ]);
      expect(calls).toEqual([["completion", "fish", "--no-descriptions"]]);
    }).pipe(Effect.provide(layer)) as Effect.Effect<void>;
  });
});
