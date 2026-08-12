import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { legacyFunctionsServeCommand } from "./serve.command.ts";

describe("legacy functions serve command", () => {
  it.live("accepts all legacy function name positional arguments", () => {
    let handlerRan = false;
    let parsedFunctionNames: ReadonlyArray<string> = [];
    const command = legacyFunctionsServeCommand.pipe(
      Command.withHandler(({ legacyFunctionNames }) =>
        Effect.sync(() => {
          handlerRan = true;
          parsedFunctionNames = legacyFunctionNames;
        }),
      ),
    );

    return Effect.gen(function* () {
      const exit = yield* Command.runWith(command, {
        version: "0.0.0-test",
      })(["hello-world", "send-email"]).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(handlerRan).toBe(true);
      expect(parsedFunctionNames).toEqual(["hello-world", "send-email"]);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });
});
