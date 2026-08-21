import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer } from "effect";
import { existsSync } from "node:fs";
import { stop } from "./stop.handler.ts";
import { managedStackDocumentPathEffect } from "@supabase/stack/managed";
import { mockOutput, mockProjectLinkState } from "../../../../tests/helpers/mocks.ts";
import { makeRunningStackFixture } from "../../../../tests/helpers/running-stack.ts";

describe("stop handler", () => {
  it.live(
    "stops a managed owner while preserving its document by default",
    () =>
      Effect.promise(() => makeRunningStackFixture()).pipe(
        Effect.flatMap((fixture) => {
          const out = mockOutput();
          const layer = Layer.mergeAll(
            fixture.baseLayer,
            out.layer,
            mockProjectLinkState(),
            BunServices.layer,
          );
          return stop({ stack: fixture.stackName, noBackup: false }).pipe(
            Effect.provide(layer),
            Effect.tap(
              Effect.sync(() => {
                expect(out.messages).toContainEqual(
                  expect.objectContaining({ type: "success", message: "Local Supabase stopped" }),
                );
                expect(existsSync(fixture.stateRoot)).toBe(true);
              }),
            ),
            Effect.ensuring(Effect.promise(() => fixture.dispose())),
          );
        }),
      ),
    30_000,
  );

  it.live("stops and removes the managed document for --no-backup", () =>
    Effect.promise(() => makeRunningStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          BunServices.layer,
        );
        return stop({ stack: fixture.stackName, noBackup: true }).pipe(
          Effect.tap(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const documentPath = yield* managedStackDocumentPathEffect(
                fixture.stateRoot,
                fixture.stackId,
              );
              expect(yield* fs.exists(documentPath)).toBe(false);
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "success",
                  message: "Local Supabase stopped and persisted data deleted",
                }),
              );
            }),
          ),
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
        );
      }),
    ),
  );
});
