import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { mockOutput, mockStdin } from "../../../tests/helpers/mocks.ts";
import { migrationConfirm } from "./migration.prompt.ts";

describe.each([true, false])("migrationConfirm answers (isTTY %j)", (isTTY) => {
  const ask = (input: string, defaultValue: boolean) =>
    migrationConfirm("Confirm?", { defaultValue, yes: false }).pipe(
      Effect.provide(Layer.mergeAll(mockOutput().layer, mockStdin(isTTY, input))),
    );

  it.effect.each(["u", "yess", "nope", "   "])(
    "declines the unrecognised answer %j whatever the default",
    (answer) =>
      Effect.gen(function* () {
        expect(yield* ask(`${answer}\n`, true)).toBe(false);
        expect(yield* ask(`${answer}\n`, false)).toBe(false);
      }),
  );

  it.effect.each([true, false])("takes the default %j for an empty line or closed stdin", (def) =>
    Effect.gen(function* () {
      expect(yield* ask("\n", def)).toBe(def);
      expect(yield* ask("", def)).toBe(def);
    }),
  );

  it.effect.each([true, false])("honours y/yes/n/no over the default %j", (def) =>
    Effect.gen(function* () {
      expect(yield* ask("y\n", def)).toBe(true);
      expect(yield* ask(" YES \n", def)).toBe(true);
      expect(yield* ask("n\n", def)).toBe(false);
      expect(yield* ask(" No \n", def)).toBe(false);
    }),
  );
});
