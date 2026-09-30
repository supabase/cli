import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import { mockOutput, mockStdin } from "../../../tests/helpers/mocks.ts";
import { migrationConfirm } from "./migration.prompt.ts";

describe.each([true, false])("migrationConfirm answers (isTTY %j)", (isTTY) => {
  const ask = (input: string, defaultValue: boolean) =>
    Effect.runPromise(
      migrationConfirm("Confirm?", { defaultValue, yes: false }).pipe(
        Effect.provide(Layer.mergeAll(mockOutput().layer, mockStdin(isTTY, input))),
      ),
    );

  it.each(["u", "yess", "nope", "   "])(
    "declines the unrecognised answer %j whatever the default",
    async (answer) => {
      expect(await ask(`${answer}\n`, true)).toBe(false);
      expect(await ask(`${answer}\n`, false)).toBe(false);
    },
  );

  it.each([true, false])("takes the default %j for an empty line or closed stdin", async (def) => {
    expect(await ask("\n", def)).toBe(def);
    expect(await ask("", def)).toBe(def);
  });

  it.each([true, false])("honours y/yes/n/no over the default %j", async (def) => {
    expect(await ask("y\n", def)).toBe(true);
    expect(await ask(" YES \n", def)).toBe(true);
    expect(await ask("n\n", def)).toBe(false);
    expect(await ask(" No \n", def)).toBe(false);
  });
});
