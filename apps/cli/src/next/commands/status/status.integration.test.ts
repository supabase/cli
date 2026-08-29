import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { status } from "./status.handler.ts";
import { emptyEnv, mockCliProjectHome, mockOutput } from "../../../../tests/helpers/mocks.ts";

describe("status handler", () => {
  it.live("reports an unknown project stack without contacting a daemon", () => {
    const out = mockOutput({ interactive: false, format: "json" });
    return status({ stack: "default" }).pipe(
      Effect.provide(
        Layer.mergeAll(emptyEnv(), out.layer, mockCliProjectHome({ projectRoot: process.cwd() })),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages.some((message) => message.type === "success")).toBe(true);
        }),
      ),
    );
  });
});
