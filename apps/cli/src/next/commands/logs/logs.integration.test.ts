import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { logs } from "./logs.handler.ts";
import { emptyEnv, mockOutput, mockProcessControl } from "../../../../tests/helpers/mocks.ts";

describe("logs handler", () => {
  it.live("fails clearly when no managed stack exists", () => {
    const out = mockOutput({ interactive: false });
    return logs({ stack: "default", service: [], tail: 10, noFollow: true }).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer, mockProcessControl().layer)),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))),
    );
  });
});
