import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyCompletionBashCommand } from "./bash.command.ts";
import { legacyCompletionBash } from "./bash.handler.ts";

function setupLegacyCompletionBash() {
  return mockOutput();
}

function legacyTestRoot() {
  return Command.make("supabase").pipe(Command.withSubcommands([legacyCompletionBashCommand]));
}

describe("legacy completion bash", () => {
  it.live("prints the native bash completion script", () => {
    const out = setupLegacyCompletionBash();
    return Effect.gen(function* () {
      yield* legacyCompletionBash({ noDescriptions: false });
      expect(out.stdoutText).toContain("# bash completion V2 for supabase");
      expect(out.stdoutText).not.toContain("__completeNoDesc");
      expect(out.stdoutText).toContain("__complete");
    }).pipe(Effect.provide(out.layer));
  });

  it.live(
    "prints the native bash completion script without descriptions when --no-descriptions is set",
    () => {
      const out = setupLegacyCompletionBash();
      return Effect.gen(function* () {
        yield* legacyCompletionBash({ noDescriptions: true });
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(out.layer));
    },
  );

  it.live(
    "accepts --no-descriptions from real argv via the command parser and still prints the no-desc script",
    () => {
      const out = setupLegacyCompletionBash();
      return Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
          "bash",
          "--no-descriptions",
        ]);
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(out.layer)) as Effect.Effect<void>;
    },
  );
});
