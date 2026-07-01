import { describe, expect, it } from "@effect/vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import { BunServices } from "@effect/platform-bun";
import { unixHttpClientLayer } from "@supabase/stack";
import { stop } from "./stop.handler.ts";
import { mockOutput, withEnv } from "../../../../tests/helpers/mocks.ts";
import {
  makeRunningStackFixture,
  makeStoppedStackFixture,
} from "../../../../tests/helpers/running-stack.ts";

describe("stop handler", () => {
  it.live("shows a friendly failure when no local stack is running", () => {
    const out = mockOutput();
    const home = mkdtempSync(join(tmpdir(), "supabase-stop-test-"));
    const layer = Layer.mergeAll(out.layer, BunServices.layer, unixHttpClientLayer);

    return Effect.gen(function* () {
      const exit = yield* stop({ stack: "default", noBackup: false }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "intro", message: "Stop local Supabase stack" }),
      );
    }).pipe(Effect.provide(layer), Effect.provide(withEnv({ SUPABASE_HOME: home })));
  });

  it.live("stops a running local stack and keeps its pinned metadata by default", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => makeRunningStackFixture()),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const out = mockOutput();
      const layer = Layer.mergeAll(fixture.baseLayer, out.layer);

      yield* stop({ stack: fixture.stackName, noBackup: false }).pipe(Effect.provide(layer));

      expect(fixture.stopped).toBe(true);
      expect(existsSync(fixture.stackStatePath)).toBe(false);
      expect(existsSync(fixture.stackMetadataPath)).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Local Supabase stopped" }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "Local Supabase stack stopped." }),
      );
    }),
  );

  it.live("deletes persisted stack state and metadata with --no-backup", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => makeRunningStackFixture()),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const out = mockOutput();
      const layer = Layer.mergeAll(fixture.baseLayer, out.layer);

      yield* stop({ stack: fixture.stackName, noBackup: true }).pipe(Effect.provide(layer));

      expect(fixture.stopped).toBe(true);
      expect(existsSync(fixture.stackStatePath)).toBe(false);
      expect(existsSync(fixture.stackMetadataPath)).toBe(false);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Local Supabase stopped and persisted data deleted",
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "Local Supabase stack stopped and local data deleted.",
        }),
      );
    }),
  );

  it.live("treats already-removed persistence as success after stopping with --no-backup", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => makeRunningStackFixture()),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const out = mockOutput();
      const layer = Layer.mergeAll(fixture.baseLayer, out.layer);

      rmSync(fixture.stackMetadataPath, { force: true });

      yield* stop({ stack: fixture.stackName, noBackup: true }).pipe(Effect.provide(layer));

      expect(fixture.stopped).toBe(true);
      expect(existsSync(fixture.stackStatePath)).toBe(false);
      expect(existsSync(fixture.stackMetadataPath)).toBe(false);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Local Supabase stopped and persisted data deleted",
        }),
      );
    }),
  );

  it.live("deletes the requested stopped named stack with --no-backup", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => makeStoppedStackFixture({ stackName: "preview" })),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const out = mockOutput();
      const layer = Layer.mergeAll(fixture.baseLayer, out.layer);

      yield* stop({ stack: "preview", noBackup: true }).pipe(Effect.provide(layer));

      expect(existsSync(fixture.stackMetadataPath)).toBe(false);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Local Supabase stopped and persisted data deleted",
        }),
      );
    }),
  );
});
