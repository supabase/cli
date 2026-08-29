import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { start } from "./start.handler.ts";
import { emptyEnv, mockOutput } from "../../../../tests/helpers/mocks.ts";

describe("start handler", () => {
  it.live("reports runtime startup failures through the command boundary", () => {
    const out = mockOutput({ interactive: false });
    return start({ stack: "default", mode: "native", exclude: [], detach: true }).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))),
    );
  });
});
