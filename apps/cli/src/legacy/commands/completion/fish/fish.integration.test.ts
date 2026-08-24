import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { mockAnalytics, mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { processControlLayer } from "../../../../shared/runtime/process-control.layer.ts";
import { EventCommandExecuted } from "../../../../shared/telemetry/event-catalog.ts";
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
      // Running through the real command (rather than calling the handler
      // directly, as the two tests above do) also runs
      // `withLegacyCommandInstrumentation` (fires the `cli_command_executed`
      // event), which needs `Analytics`/`ProcessControl`/`Stdio` alongside
      // `Output` — the same minimal layer set `telemetry.integration.test.ts`
      // uses for its own local-only (no Management API) native command.
      const layer = Layer.mergeAll(
        out.layer,
        mockAnalytics().layer,
        BunServices.layer,
        processControlLayer,
      );
      return Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })([
          "fish",
          "--no-descriptions",
        ]);
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fires the cli_command_executed telemetry event, matching Go's PersistentPostRun (CLI-1965 review finding)",
    () => {
      const out = setupLegacyCompletionFish();
      const analytics = mockAnalytics();
      const layer = Layer.mergeAll(
        out.layer,
        analytics.layer,
        BunServices.layer,
        processControlLayer,
      );
      return Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["fish"]);
        const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
        expect(event).toBeDefined();
      }).pipe(Effect.provide(layer));
    },
  );
});
