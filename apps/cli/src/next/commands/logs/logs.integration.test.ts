import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { logs } from "./logs.handler.ts";
import {
  mockOutput,
  mockProcessControl,
  mockProjectLinkState,
} from "../../../../tests/helpers/mocks.ts";
import { makeRunningStackFixture } from "../../../../tests/helpers/running-stack.ts";

describe("logs handler", () => {
  it.live("attaches to managed control and renders persisted and live history", () =>
    Effect.promise(() => makeRunningStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        const out = mockOutput();
        const processControl = mockProcessControl();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          processControl.layer,
          mockProjectLinkState(),
          BunServices.layer,
        );
        return logs({ stack: fixture.stackName, service: [], tail: 10, noFollow: false }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              expect(out.messages).toContainEqual(
                expect.objectContaining({ type: "info", message: "[postgres] ready" }),
              );
            }),
          ),
        );
      }),
    ),
  );
});
