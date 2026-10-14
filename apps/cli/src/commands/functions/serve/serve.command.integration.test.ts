import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option, Ref } from "effect";
import { CliOutput, Command } from "effect/cli";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { functionsServeCommand } from "./serve.command.ts";

describe("functions serve command", () => {
  it.effect("accepts all legacy function name positional arguments", () =>
    Effect.gen(function* () {
      const parsedFunctionNames = yield* Ref.make(Option.none<ReadonlyArray<string>>());
      const command = functionsServeCommand.pipe(
        Command.withHandler(({ functionNames }) =>
          Ref.set(parsedFunctionNames, Option.some(functionNames)),
        ),
      );

      const exit = yield* Command.runWith(command, {
        version: "0.0.0-test",
      })(["hello-world", "send-email"]).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* Ref.get(parsedFunctionNames)).toEqual(
        Option.some(["hello-world", "send-email"]),
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    ),
  );
});
