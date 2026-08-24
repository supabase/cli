import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { DEFAULT_VERSIONS } from "@supabase/stack/effect";
import { update } from "./update.handler.ts";
import {
  mockOutput,
  mockProjectLinkState,
  mockProjectLinkRemote,
  mockProjectLocalServiceVersions,
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
          mockProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return Effect.gen(function* () {
          yield* update({ stack: fixture.stackName });
          const document = yield* Effect.promise(() => fixture.readDocument());
          expect(document?.launch?.versions).toEqual(DEFAULT_VERSIONS);
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
        }).pipe(Effect.provide(layer), Effect.ensuring(Effect.promise(() => fixture.dispose())));
      }),
    ),
  );

  it.live("prepares versions before the first managed stack start", () =>
    Effect.promise(() => makeStoppedStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockProjectLinkRemote(),
          mockProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.remove(path.join(fixture.stateRoot, "stacks", fixture.stackId), {
            recursive: true,
            force: true,
          });
          yield* update({ stack: fixture.stackName });
          expect(yield* Effect.promise(() => fixture.readDocument())).toBeUndefined();
          expect(out.messages).toContainEqual(
            expect.objectContaining({
              type: "success",
              message: "Pinned stack versions are already up to date.",
            }),
          );
        }).pipe(Effect.provide(layer), Effect.ensuring(Effect.promise(() => fixture.dispose())));
      }),
    ),
  );
});
