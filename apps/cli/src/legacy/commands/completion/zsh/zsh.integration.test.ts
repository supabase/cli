import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { mockAnalytics, mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { processControlLayer } from "../../../../shared/runtime/process-control.layer.ts";
import { EventCommandExecuted } from "../../../../shared/telemetry/event-catalog.ts";
import { legacyCompletionZshCommand } from "./zsh.command.ts";
import { legacyCompletionZsh } from "./zsh.handler.ts";

function setupLegacyCompletionZsh() {
  return mockOutput();
}

function legacyTestRoot() {
  return Command.make("supabase").pipe(Command.withSubcommands([legacyCompletionZshCommand]));
}

describe("legacy completion zsh", () => {
  it.live("prints the native zsh completion script", () => {
    const out = setupLegacyCompletionZsh();
    return Effect.gen(function* () {
      yield* legacyCompletionZsh({ noDescriptions: false });
      expect(out.stdoutText).toContain("#compdef supabase");
      expect(out.stdoutText).not.toContain("__completeNoDesc");
      expect(out.stdoutText).toContain("__complete");
    }).pipe(Effect.provide(out.layer));
  });

  it.live(
    "prints the native zsh completion script without descriptions when --no-descriptions is set",
    () => {
      const out = setupLegacyCompletionZsh();
      return Effect.gen(function* () {
        yield* legacyCompletionZsh({ noDescriptions: true });
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(out.layer));
    },
  );

  it.live(
    "accepts --no-descriptions from real argv via the command parser and still prints the no-desc script",
    () => {
      const out = setupLegacyCompletionZsh();
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
          "zsh",
          "--no-descriptions",
        ]);
        expect(out.stdoutText).toContain("__completeNoDesc");
      }).pipe(Effect.provide(layer)) as Effect.Effect<void>;
    },
  );

  it.live(
    "fires the cli_command_executed telemetry event, matching Go's PersistentPostRun (CLI-1965 review finding)",
    () => {
      const out = setupLegacyCompletionZsh();
      const analytics = mockAnalytics();
      const layer = Layer.mergeAll(
        out.layer,
        analytics.layer,
        BunServices.layer,
        processControlLayer,
      );
      return Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot(), { version: "0.0.0-test" })(["zsh"]);
        const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
        expect(event).toBeDefined();
      }).pipe(Effect.provide(layer)) as Effect.Effect<void>;
    },
  );
});
