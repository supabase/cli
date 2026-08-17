import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { status } from "./status.handler.ts";
import {
  mockOutput,
  mockProjectLinkState,
  mockProjectLocalServiceVersions,
} from "../../../../tests/helpers/mocks.ts";
import {
  makeRunningStackFixture,
  makeStoppedStackFixture,
} from "../../../../tests/helpers/running-stack.ts";

describe("status handler", () => {
  it.live("attaches to a managed owner and renders live service information", () =>
    Effect.promise(() => makeRunningStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return status({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "success",
                  message: "Local Supabase stack is running.",
                }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "info",
                  message: `API URL: ${fixture.stackInfo.url}`,
                }),
              );
            }),
          ),
        );
      }),
    ),
  );

  it.live("reads stopped launch metadata from the managed document", () =>
    Effect.promise(() => makeStoppedStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return status({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() =>
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "info",
                  message: "Local Supabase stack is stopped.",
                }),
              ),
            ),
          ),
        );
      }),
    ),
  );
});
