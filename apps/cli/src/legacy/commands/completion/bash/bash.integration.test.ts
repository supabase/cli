import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyCompletionBashCommand } from "./bash.command.ts";
import { legacyCompletionBash } from "./bash.handler.ts";

function setupLegacyCompletionBash() {
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
  return Command.make("supabase").pipe(Command.withSubcommands([legacyCompletionBashCommand]));
}

describe("legacy completion bash", () => {
  it.live("forwards `completion bash` to the Go binary", () => {
    const { layer, calls } = setupLegacyCompletionBash();
    return Effect.gen(function* () {
      yield* legacyCompletionBash({ noDescriptions: false });
      expect(calls).toEqual([["completion", "bash"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --no-descriptions when set", () => {
    const { layer, calls } = setupLegacyCompletionBash();
    return Effect.gen(function* () {
      yield* legacyCompletionBash({ noDescriptions: true });
      expect(calls).toEqual([["completion", "bash", "--no-descriptions"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts --no-descriptions from real argv via the command parser", () => {
    const { layer, calls } = setupLegacyCompletionBash();
    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
        "bash",
        "--no-descriptions",
      ]);
      expect(calls).toEqual([["completion", "bash", "--no-descriptions"]]);
    }).pipe(Effect.provide(layer)) as Effect.Effect<void>;
  });
});
