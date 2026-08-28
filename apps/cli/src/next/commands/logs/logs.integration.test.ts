import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer } from "effect";
import { logs } from "./logs.handler.ts";
import {
  mockOutput,
  mockProcessControl,
  mockProjectLinkState,
} from "../../../../tests/helpers/mocks.ts";
import { makeRunningStackFixture } from "../../../../tests/helpers/running-stack.ts";

describe("logs handler", () => {
  it.live("fails with an actionable upgrade error without restarting an incompatible owner", () =>
    Effect.promise(() =>
      makeRunningStackFixture({
        cliVersion: "2.60.0",
      }),
    ).pipe(
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
          Effect.exit,
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(JSON.stringify(exit.cause)).toContain("DaemonUpgradeRequired");
              }
              expect(processControl.exitCalls).toEqual([]);
              expect(out.messages).not.toContainEqual(
                expect.objectContaining({
                  type: "info",
                  message: expect.stringContaining("[postgres]"),
                }),
              );
            }),
          ),
        );
      }),
    ),
  );

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
