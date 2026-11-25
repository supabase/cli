import { describe, expect, it } from "@effect/vitest";
import { BunCrypto, BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option, Schema, Stdio } from "effect";
import { Command } from "effect/cli";

import { mockAnalytics, mockOutput } from "../../../../tests/helpers/mocks.ts";
import { GLOBAL_OUTPUT_FORMATS, OutputFlag } from "../../../command-internal/global-flags.ts";
import { InvalidOutputFormatError } from "../../../command-internal/output-formats.ts";
import { processControlLayer } from "../../../shared/runtime/process-control.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { EventCommandExecuted, PropSkillTopic } from "../../../shared/telemetry/event-catalog.ts";
import { skillDisplayHandler } from "./display.command.ts";
import {
  SkillDisplayOutputFlagUnsupportedError,
  SkillTopicNotFoundError,
} from "./display.errors.ts";
import { skillDisplay } from "./display.handler.ts";
import { skillCommand } from "../skill.command.ts";

const testRoot = () => Command.make("supabase").pipe(Command.withSubcommands([skillCommand]));

function setup(opts: { readonly outputFlag?: (typeof GLOBAL_OUTPUT_FORMATS)[number] } = {}) {
  const out = mockOutput();
  const analytics = mockAnalytics();
  const layer = Layer.mergeAll(
    out.layer,
    analytics.layer,
    BunServices.layer,
    BunCrypto.layer,
    processControlLayer,
    Layer.succeed(
      OutputFlag,
      opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
    ),
  );
  return { out, analytics, layer };
}

const run = (argv: ReadonlyArray<string>) =>
  Command.runWith(testRoot(), { version: "0.0.0-test" })(argv);

function findError(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) return undefined;
  return Option.getOrUndefined(Cause.findErrorOption(exit.cause));
}

describe("skill display", () => {
  it.effect("prints the overview when no topic is given", () => {
    const { out, layer } = setup();
    return Effect.gen(function* () {
      yield* run(["skill", "display"]);
      expect(out.stdoutText.startsWith("# Supabase CLI: agent overview")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a mixed-case topic and records its canonical slug", () => {
    const { out, analytics, layer } = setup();
    return Effect.gen(function* () {
      yield* run(["skill", "display", "Overview"]);
      expect(out.stdoutText.startsWith("# Supabase CLI: agent overview")).toBe(true);
      const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
      expect(event?.properties[PropSkillTopic]).toBe("overview");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails an unknown topic without recording or leaking the input", () => {
    const { out, analytics, layer } = setup();
    return Effect.gen(function* () {
      const error = findError(yield* run(["skill", "display", "nope"]).pipe(Effect.exit));
      expect(error).toBeInstanceOf(SkillTopicNotFoundError);
      if (error instanceof SkillTopicNotFoundError) {
        expect(error.message).toBe('Unknown skill topic "nope".');
        expect(error.suggestion).toContain("overview");
      }
      expect(out.stdoutText).toBe("");
      const event = analytics.captured.find((entry) => entry.event === EventCommandExecuted);
      expect(event).toBeDefined();
      expect(event?.properties).not.toHaveProperty(PropSkillTopic);
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        analytics.captured,
      );
      expect(serialized).not.toContain("nope");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects every -o/--output value without printing", () => {
    const check = (outputFlag: (typeof GLOBAL_OUTPUT_FORMATS)[number]) => {
      const { out, layer } = setup({ outputFlag });
      return Effect.gen(function* () {
        const error = findError(yield* skillDisplay({ topic: Option.none() }).pipe(Effect.exit));
        expect(error).toBeInstanceOf(SkillDisplayOutputFlagUnsupportedError);
        expect(out.rawChunks).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    };
    return Effect.forEach(GLOBAL_OUTPUT_FORMATS, check, { discard: true });
  });

  it.effect("routes -o table/csv through the command's own error, not the format validator", () => {
    const check = (outputFlag: "table" | "csv") => {
      const { out, layer } = setup({ outputFlag });
      return Effect.gen(function* () {
        const error = findError(
          yield* skillDisplayHandler({ topic: Option.none() }).pipe(Effect.exit),
        );
        expect(error).toBeInstanceOf(SkillDisplayOutputFlagUnsupportedError);
        expect(error).not.toBeInstanceOf(InvalidOutputFormatError);
        expect(out.rawChunks).toHaveLength(0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            commandRuntimeLayer(["skill", "display"]).pipe(Layer.provide(BunCrypto.layer)),
            Stdio.layerTest({ args: Effect.succeed(["skill", "display", "-o", outputFlag]) }),
          ),
        ),
      );
    };
    return Effect.forEach(["table", "csv"] as const, check, { discard: true });
  });
});
