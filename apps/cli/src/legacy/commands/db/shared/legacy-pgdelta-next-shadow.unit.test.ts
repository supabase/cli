import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Layer } from "effect";

import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import { legacyPgDeltaNextShadowLayer } from "./legacy-pgdelta-next-shadow.layer.ts";
import { LegacyPgDeltaNextShadow } from "./legacy-pgdelta-next-shadow.service.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

class PrimaryFailure extends Data.TaggedError("PrimaryFailure")<{
  readonly message: string;
}> {}

function setup(
  opts: {
    readonly sourceUrl?: string;
    readonly scratchUrl?: string;
    readonly cleanupDefect?: boolean;
  } = {},
) {
  const state = {
    provisionCalls: [] as object[],
    removedContainers: [] as string[],
    legacyMethodCalls: [] as string[],
  };
  const seamLayer = Layer.succeed(
    LegacyDeclarativeSeam,
    LegacyDeclarativeSeam.of({
      exportCatalog: () =>
        Effect.sync(() => {
          state.legacyMethodCalls.push("exportCatalog");
          return "catalog.json";
        }),
      execInherit: () =>
        Effect.sync(() => {
          state.legacyMethodCalls.push("execInherit");
          return 0;
        }),
      ensureLocalDatabaseStarted: () =>
        Effect.sync(() => {
          state.legacyMethodCalls.push("ensureLocalDatabaseStarted");
        }),
      ensureLocalPostgresImageCurrent: () =>
        Effect.sync(() => {
          state.legacyMethodCalls.push("ensureLocalPostgresImageCurrent");
        }),
      provisionShadow: (input) =>
        Effect.sync(() => {
          state.provisionCalls.push(input);
          return {
            container: "next-shadow-container",
            sourceUrl: opts.sourceUrl ?? "postgresql://postgres@localhost:55432/postgres",
            targetUrlOverride: opts.scratchUrl,
          };
        }),
      removeShadowContainer: (container) =>
        Effect.gen(function* () {
          state.removedContainers.push(container);
          if (opts.cleanupDefect === true) {
            return yield* Effect.die("cleanup failed");
          }
        }),
    }),
  );

  return {
    state,
    layer: legacyPgDeltaNextShadowLayer.pipe(Layer.provide(seamLayer)),
  };
}

describe("LegacyPgDeltaNextShadow", () => {
  it.effect("provisions the exact next mode and exposes the migrated and scratch URLs", () => {
    const { layer, state } = setup({
      scratchUrl: "postgresql://postgres@localhost:55432/pgdelta_declarative",
    });

    return Effect.gen(function* () {
      const databases = yield* Effect.scoped(
        Effect.gen(function* () {
          const shadow = yield* LegacyPgDeltaNextShadow;
          const acquired = yield* shadow.provision({
            schema: ["public", "extensions"],
            projectRef: "linked-project",
          });
          expect(state.removedContainers).toEqual([]);
          return acquired;
        }),
      );

      expect(databases).toEqual({
        migrationsUrl: "postgresql://postgres@localhost:55432/postgres",
        scratchUrl: "postgresql://postgres@localhost:55432/pgdelta_declarative",
      });
      expect(Object.keys(databases)).toEqual(["migrationsUrl", "scratchUrl"]);
      expect(state.provisionCalls).toEqual([
        {
          mode: "pgdelta-next",
          targetLocal: false,
          usePgDelta: false,
          schema: ["public", "extensions"],
          projectRef: "linked-project",
        },
      ]);
      expect(state.removedContainers).toEqual(["next-shadow-container"]);
      expect(state.legacyMethodCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("cleans up when the caller fails and never lets cleanup mask that failure", () => {
    const { layer, state } = setup({
      scratchUrl: "postgresql://postgres@localhost:55432/pgdelta_declarative",
      cleanupDefect: true,
    });
    const primary = new PrimaryFailure({ message: "caller failed" });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const shadow = yield* LegacyPgDeltaNextShadow;
          yield* shadow.provision({ schema: [] });
          return yield* Effect.fail(primary);
        }),
      ).pipe(Effect.flip);

      expect(error).toEqual(primary);
      expect(state.removedContainers).toEqual(["next-shadow-container"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("cleans up and fails when the declarative scratch URL is missing", () => {
    const { layer, state } = setup();

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const shadow = yield* LegacyPgDeltaNextShadow;
          return yield* shadow.provision({ schema: ["public"] });
        }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LegacyDeclarativeShadowDbError);
      expect(error.message).toContain("missing declarative scratch URL");
      expect(state.removedContainers).toEqual(["next-shadow-container"]);
      expect(state.provisionCalls).toEqual([
        {
          mode: "pgdelta-next",
          targetLocal: false,
          usePgDelta: false,
          schema: ["public"],
        },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
