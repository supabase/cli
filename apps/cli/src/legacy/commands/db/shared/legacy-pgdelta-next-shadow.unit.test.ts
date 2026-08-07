import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { legacyPgDeltaNextShadowLayer } from "./legacy-pgdelta-next-shadow.layer.ts";
import { LegacyPgDeltaNextShadow } from "./legacy-pgdelta-next-shadow.service.ts";
import { legacyParseNextShadowProtocol } from "./legacy-pgdelta.seam.layer.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

function setup() {
  const state = {
    provisionCalls: [] as object[],
    legacyMethodCalls: [] as string[],
  };
  const seamLayer = Layer.succeed(
    LegacyDeclarativeSeam,
    LegacyDeclarativeSeam.of({
      exportCatalog: () => Effect.die("exportCatalog not used"),
      ensureLocalDatabaseStarted: () => Effect.die("ensureLocalDatabaseStarted not used"),
      ensureLocalPostgresImageCurrent: () => Effect.die("ensureLocalPostgresImageCurrent not used"),
      provisionShadow: () => Effect.die("provisionShadow not used"),
      provisionNextShadow: (input) =>
        Effect.sync(() => {
          state.provisionCalls.push(input);
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
  it("validates the dual-shadow JSON protocol structurally", () => {
    expect(
      legacyParseNextShadowProtocol(
        JSON.stringify({
          migrations: {
            containerId: "migrations-container",
            url: "postgresql://postgres@localhost:55432/postgres",
          },
          declarative: {
            containerId: "declarative-container",
            url: "postgresql://postgres@localhost:55433/postgres",
          },
        }),
      ),
    ).toEqual({
      migrations: {
        containerId: "migrations-container",
        url: "postgresql://postgres@localhost:55432/postgres",
      },
      declarative: {
        containerId: "declarative-container",
        url: "postgresql://postgres@localhost:55433/postgres",
      },
    });

    expect(() => legacyParseNextShadowProtocol("not json")).toThrow();
    expect(() => legacyParseNextShadowProtocol('{"migrations":{}}')).toThrow();
    expect(() =>
      legacyParseNextShadowProtocol(
        JSON.stringify({
          migrations: { containerId: "same", url: "postgresql://localhost/postgres" },
          declarative: { containerId: "same", url: "postgresql://localhost/postgres" },
        }),
      ),
    ).toThrow("next-shadow containers must be distinct");
  });

  it.effect("delegates to the isolated next-shadow seam and exposes both postgres URLs", () => {
    const { layer, state } = setup();

    return Effect.gen(function* () {
      const databases = yield* Effect.scoped(
        Effect.gen(function* () {
          const shadow = yield* LegacyPgDeltaNextShadow;
          return yield* shadow.provision({
            schema: ["public", "extensions"],
            projectRef: "linked-project",
          });
        }),
      );

      expect(databases).toEqual({
        migrationsUrl: "postgresql://postgres:secret@localhost:55432/postgres",
        declarativeUrl: "postgresql://postgres:secret@localhost:55433/postgres",
      });
      expect(Object.keys(databases)).toEqual(["migrationsUrl", "declarativeUrl"]);
      expect(state.provisionCalls).toEqual([
        {
          schema: ["public", "extensions"],
          projectRef: "linked-project",
        },
      ]);
      expect(state.legacyMethodCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
