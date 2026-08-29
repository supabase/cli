import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { stop } from "./stop.handler.ts";
import { emptyEnv, mockOutput } from "../../../../tests/helpers/mocks.ts";

describe("stop handler", () => {
  it.live("fails clearly when no stack descriptor exists", () => {
    const out = mockOutput({ interactive: false });
    return stop({ stack: "default", noBackup: false }).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))),
    );
  });
});
