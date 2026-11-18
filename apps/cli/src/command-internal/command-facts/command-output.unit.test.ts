import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import * as CommandOutput from "./command-output.ts";

const config = { name: Argument.String("name") } as const;
type Input = Command.Command.Config.Infer<typeof config>;

const Named = Schema.Struct({ name: Schema.String });
const namedOutput = CommandOutput.make({ schema: Named, text: () => Effect.void });

describe("CommandOutput.withHandler", () => {
  it("accepts a handler typed from the command's input", () => {
    const handler = (input: Input) => Effect.succeed({ name: input.name });
    const leaf = Command.make("leaf", config).pipe(
      CommandOutput.withHandler(namedOutput, handler, (emitting) => emitting),
    );
    expect(leaf.name).toBe("leaf");
  });

  it("rejects a handler that expects input the command doesn't define", () => {
    const handler = (input: Input & { readonly force: boolean }) =>
      Effect.succeed({ name: input.force ? input.name : "" });
    const leaf = Command.make("leaf", config).pipe(
      // @ts-expect-error -- the command has no `force` input
      CommandOutput.withHandler(namedOutput, handler, (emitting) => emitting),
    );
    expect(leaf).toHaveProperty("name", "leaf");
  });

  it("rejects a handler whose result doesn't match the output schema", () => {
    const handler = (input: Input) => Effect.succeed({ name: input.name.length });
    const leaf = Command.make("leaf", config).pipe(
      // @ts-expect-error -- `name` is a number, the schema declares a string
      CommandOutput.withHandler(namedOutput, handler, (emitting) => emitting),
    );
    expect(leaf).toHaveProperty("name", "leaf");
  });
});
