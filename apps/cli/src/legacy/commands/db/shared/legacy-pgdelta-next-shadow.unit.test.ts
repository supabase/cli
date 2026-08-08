import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { legacyPgDeltaNextShadowLayer } from "./legacy-pgdelta-next-shadow.layer.ts";
import { LegacyPgDeltaNextShadow } from "./legacy-pgdelta-next-shadow.service.ts";
import {
  legacyParseNextMigrationsShadowProtocol,
  legacyParseNextPlanShadowProtocol,
} from "./legacy-pgdelta.seam.layer.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

function setup() {
  const state = {
    migrationsCalls: [] as object[],
    planCalls: [] as object[],
  };
  const seamLayer = Layer.succeed(
    LegacyDeclarativeSeam,
    LegacyDeclarativeSeam.of({
      exportCatalog: () => Effect.die("exportCatalog not used"),
      ensureLocalDatabaseStarted: () => Effect.die("ensureLocalDatabaseStarted not used"),
      ensureLocalPostgresImageCurrent: () => Effect.die("ensureLocalPostgresImageCurrent not used"),
      provisionShadow: () => Effect.die("provisionShadow not used"),
      provisionNextMigrationsShadow: (input) =>
        Effect.sync(() => {
          state.migrationsCalls.push(input);
          return {
            migrationsUrl: "postgresql://postgres:secret@localhost:55432/postgres",
          };
        }),
      provisionNextPlanShadows: (input) =>
        Effect.sync(() => {
          state.planCalls.push(input);
          return {
            migrationsUrl: "postgresql://postgres:secret@localhost:55432/postgres",
            declarativeUrl: "postgresql://postgres:secret@localhost:55433/postgres",
          };
        }),
      removeShadowContainer: () => Effect.die("removeShadowContainer not used"),
    }),
  );

  return {
    state,
    layer: legacyPgDeltaNextShadowLayer.pipe(Layer.provide(seamLayer)),
  };
}

describe("LegacyPgDeltaNextShadow", () => {
  it("validates the mode-specific JSON protocols structurally", () => {
    const migrations = {
      containerId: "migrations-container",
      url: "postgresql://postgres@localhost:55432/postgres",
    };
    const declarative = {
      containerId: "declarative-container",
      url: "postgresql://postgres@localhost:55433/postgres",
    };

    expect(legacyParseNextMigrationsShadowProtocol(JSON.stringify({ migrations }))).toEqual({
      migrations,
    });
    expect(legacyParseNextPlanShadowProtocol(JSON.stringify({ migrations, declarative }))).toEqual({
      migrations,
      declarative,
    });

    expect(() => legacyParseNextMigrationsShadowProtocol("not json")).toThrow();
    expect(() => legacyParseNextMigrationsShadowProtocol('{"migrations":{}}')).toThrow();
    expect(() =>
      legacyParseNextMigrationsShadowProtocol(JSON.stringify({ migrations, declarative })),
    ).toThrow("unexpected declarative database");
    expect(() => legacyParseNextPlanShadowProtocol(JSON.stringify({ migrations }))).toThrow();
    expect(() =>
      legacyParseNextPlanShadowProtocol(
        JSON.stringify({
          migrations,
          declarative: { ...declarative, containerId: migrations.containerId },
        }),
      ),
    ).toThrow("next-shadow containers must be distinct");
  });

  it.effect("provisions only the migrated database for a database diff", () => {
    const { layer, state } = setup();

    return Effect.gen(function* () {
      const databases = yield* Effect.scoped(
        Effect.gen(function* () {
          const shadow = yield* LegacyPgDeltaNextShadow;
          return yield* shadow.provisionMigrations({
            schema: ["public"],
            projectRef: "linked-project",
          });
        }),
      );

      expect(databases).toEqual({
        migrationsUrl: "postgresql://postgres:secret@localhost:55432/postgres",
      });
      expect(state.migrationsCalls).toEqual([{ schema: ["public"], projectRef: "linked-project" }]);
      expect(state.planCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("provisions both isolated databases for a declarative plan", () => {
    const { layer, state } = setup();

    return Effect.gen(function* () {
      const databases = yield* Effect.scoped(
        Effect.gen(function* () {
          const shadow = yield* LegacyPgDeltaNextShadow;
          return yield* shadow.provisionPlan({ schema: ["public", "extensions"] });
        }),
      );

      expect(databases).toEqual({
        migrationsUrl: "postgresql://postgres:secret@localhost:55432/postgres",
        declarativeUrl: "postgresql://postgres:secret@localhost:55433/postgres",
      });
      expect(state.migrationsCalls).toEqual([]);
      expect(state.planCalls).toEqual([{ schema: ["public", "extensions"] }]);
    }).pipe(Effect.provide(layer));
  });
});
