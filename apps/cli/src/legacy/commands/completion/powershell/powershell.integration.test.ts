import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyCompletionPowershellCommand } from "./powershell.command.ts";
import { legacyCompletionPowershell } from "./powershell.handler.ts";

function setupLegacyCompletionPowershell() {
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
  return Command.make("supabase").pipe(
    Command.withSubcommands([legacyCompletionPowershellCommand]),
  );
}

describe("legacy completion powershell", () => {
  it.live("forwards `completion powershell` to the Go binary", () => {
    const { layer, calls } = setupLegacyCompletionPowershell();
    return Effect.gen(function* () {
      yield* legacyCompletionPowershell({ noDescriptions: false });
      expect(calls).toEqual([["completion", "powershell"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --no-descriptions when set", () => {
    const { layer, calls } = setupLegacyCompletionPowershell();
    return Effect.gen(function* () {
      yield* legacyCompletionPowershell({ noDescriptions: true });
      expect(calls).toEqual([["completion", "powershell", "--no-descriptions"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts --no-descriptions from real argv via the command parser", () => {
    const { layer, calls } = setupLegacyCompletionPowershell();
    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
        "powershell",
        "--no-descriptions",
      ]);
      expect(calls).toEqual([["completion", "powershell", "--no-descriptions"]]);
    }).pipe(Effect.provide(layer)) as Effect.Effect<void>;
  });
});
