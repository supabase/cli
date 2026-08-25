import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VERSIONS } from "@supabase/stack/effect";
import { update } from "./update.handler.ts";
import {
  mockOutput,
  mockProjectLinkState,
  mockProjectLinkRemote,
  mockCliProjectLocalServiceVersions,
} from "../../../../tests/helpers/mocks.ts";
import {
  makeRunningStackFixture,
  makeStoppedStackFixture,
} from "../../../../tests/helpers/running-stack.ts";

describe("update handler", () => {
  it.live("updates pinned versions through the managed launch document", () =>
    Effect.promise(() => makeRunningStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockProjectLinkRemote(),
          mockCliProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return update({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.tap(
            Effect.promise(async () => {
              const document = await fixture.readDocument();
              expect(document?.launch?.versions).toEqual(DEFAULT_VERSIONS);
            }),
          ),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "success",
                  message: "Updated pinned local stack versions.",
                }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "info",
                  message: expect.stringContaining("postgres:"),
                }),
              );
            }),
          ),
        );
      }),
    ),
  );

  it.live("prepares versions before the first managed stack start", () =>
    Effect.promise(() => makeStoppedStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        rmSync(join(fixture.stateRoot, "stacks", fixture.stackId), {
          recursive: true,
          force: true,
        });
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockProjectLinkRemote(),
          mockCliProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return update({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.tap(
            Effect.promise(async () => {
              expect(await fixture.readDocument()).toBeUndefined();
            }),
          ),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "success",
                  message: "Pinned stack versions are already up to date.",
                }),
              );
            }),
          ),
        );
      }),
    ),
  );
});
