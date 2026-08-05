import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyCompletionFishCommand } from "./fish.command.ts";
import { legacyCompletionFish } from "./fish.handler.ts";

function setupLegacyCompletionFish() {
  return mockOutput();
}

function legacyTestRoot() {
  return Command.make("supabase").pipe(Command.withSubcommands([legacyCompletionFishCommand]));
}

describe("legacy completion fish", () => {
  it.live("prints the native fish completion script", () => {
    const out = setupLegacyCompletionFish();
    return Effect.gen(function* () {
      yield* legacyCompletionFish({ noDescriptions: false });
      expect(out.stdoutText).toContain("# fish completion for supabase");
      expect(out.stdoutText).not.toContain("__completeNoDesc");
      expect(out.stdoutText).toContain("__complete");
    }).pipe(Effect.provide(out.layer));
  });

  it.live(
    "prints the native fish completion script without descriptions when --no-descriptions is set",
    () => {
      const out = setupLegacyCompletionFish();
      return Effect.gen(function* () {
        yield* legacyCompletionFish({ noDescriptions: true });
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(out.layer));
    },
  );

  it.live(
    "accepts --no-descriptions from real argv via the command parser and still prints the no-desc script",
    () => {
      const out = setupLegacyCompletionFish();
      return Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
          "fish",
          "--no-descriptions",
        ]);
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(out.layer)) as Effect.Effect<void>;
    },
  );
});
