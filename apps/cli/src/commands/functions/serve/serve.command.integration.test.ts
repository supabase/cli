import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { functionsServeCommand } from "./serve.command.ts";

describe("functions serve command", () => {
  it.live("accepts all legacy function name positional arguments", () => {
    let handlerRan = false;
    let parsedFunctionNames: ReadonlyArray<string> = [];
    const command = functionsServeCommand.pipe(
      Command.withHandler(({ functionNames }) =>
        Effect.sync(() => {
          handlerRan = true;
          parsedFunctionNames = functionNames;
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
