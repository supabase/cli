import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyCompletionPowershellCommand } from "./powershell.command.ts";
import { legacyCompletionPowershell } from "./powershell.handler.ts";

function setupLegacyCompletionPowershell() {
  return mockOutput();
}

function legacyTestRoot() {
  return Command.make("supabase").pipe(
    Command.withSubcommands([legacyCompletionPowershellCommand]),
  );
}

describe("legacy completion powershell", () => {
  it.live("prints the native powershell completion script", () => {
    const out = setupLegacyCompletionPowershell();
    return Effect.gen(function* () {
      yield* legacyCompletionPowershell({ noDescriptions: false });
      expect(out.stdoutText).toContain("# powershell completion for supabase");
      expect(out.stdoutText).not.toContain("__completeNoDesc");
      expect(out.stdoutText).toContain("__complete");
    }).pipe(Effect.provide(out.layer));
  });

  it.live(
    "prints the native powershell completion script without descriptions when --no-descriptions is set",
    () => {
      const out = setupLegacyCompletionPowershell();
      return Effect.gen(function* () {
        yield* legacyCompletionPowershell({ noDescriptions: true });
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(out.layer));
    },
  );

  it.live(
    "accepts --no-descriptions from real argv via the command parser and still prints the no-desc script",
    () => {
      const out = setupLegacyCompletionPowershell();
      return Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
          "powershell",
          "--no-descriptions",
        ]);
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(out.layer)) as Effect.Effect<void>;
    },
  );
});
