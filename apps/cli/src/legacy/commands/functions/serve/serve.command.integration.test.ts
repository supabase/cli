import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { legacyFunctionsServeCommand } from "./serve.command.ts";

describe("legacy functions serve command", () => {
  it.live("accepts the legacy function name positional argument", () => {
    let handlerRan = false;
    const command = legacyFunctionsServeCommand.pipe(
      Command.withHandler(() =>
        Effect.sync(() => {
          handlerRan = true;
        }),
      ),
    );

    return Effect.gen(function* () {
      const exit = yield* Command.runWith(command, {
        version: "0.0.0-test",
      })(["hello-world"]).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(handlerRan).toBe(true);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });
});
