import { Effect, Exit, Layer } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";

import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacyPgDeltaEngineSelectorLayer } from "./legacy-pgdelta-engine.layer.ts";
import { LegacyPgDeltaEngine } from "./legacy-pgdelta-engine.service.ts";

function debugLayer(messages: Array<string>) {
  return Layer.succeed(LegacyDebugLogger, {
    debug: (message) => Effect.sync(() => messages.push(message)),
    http: () => Effect.void,
  });
}

function metadataLayer(implementation: "next" | "legacy") {
  return Layer.succeed(
    LegacyPgDeltaEngine,
    LegacyPgDeltaEngine.of({
      implementation,
      diffExplicit: () => Effect.die(`${implementation} explicit diff not needed`),
      diffDatabase: () => Effect.die(`${implementation} database diff not needed`),
      exportDeclarativeSchema: () => Effect.die(`${implementation} export not needed`),
      planDeclarativeSchema: () => Effect.die(`${implementation} plan not needed`),
    }),
  );
}

describe("legacyPgDeltaEngineSelectorLayer", () => {
  it.effect("selects next by default and logs the decision once", () => {
    const messages: Array<string> = [];
    return Effect.gen(function* () {
      const engine = yield* LegacyPgDeltaEngine;
      expect(engine.implementation).toBe("next");
      expect(messages).toEqual(["Using pg-delta next implementation."]);
    }).pipe(
      Effect.provide(
        legacyPgDeltaEngineSelectorLayer(undefined, {
          next: metadataLayer("next"),
          legacy: metadataLayer("legacy"),
        }).pipe(Layer.provide(debugLayer(messages))),
      ),
    );
  });

  it.effect("does not invoke legacy after a selected next operation fails", () => {
    const messages: Array<string> = [];
    let nextCalls = 0;
    let legacyCalls = 0;
    const next = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        implementation: "next",
        diffExplicit: () =>
          Effect.sync(() => {
            nextCalls += 1;
          }).pipe(Effect.andThen(Effect.die("next diff failed"))),
        diffDatabase: () => Effect.die("next database diff failed"),
        exportDeclarativeSchema: () => Effect.die("next export failed"),
        planDeclarativeSchema: () => Effect.die("next plan failed"),
      }),
    );
    const legacy = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        implementation: "legacy",
        diffExplicit: () =>
          Effect.sync(() => {
            legacyCalls += 1;
            return {
              changes: false,
              sql: "",
              files: [],
            };
          }),
        diffDatabase: () => Effect.die("legacy database diff should not run"),
        exportDeclarativeSchema: () => Effect.die("legacy export should not run"),
        planDeclarativeSchema: () => Effect.die("legacy plan should not run"),
      }),
    );

    return Effect.gen(function* () {
      const engine = yield* LegacyPgDeltaEngine;
      const exit = yield* engine
        .diffExplicit({
          context: {
            projectId: "test",
            cwd: "/tmp/test",
            npmVersion: undefined,
            denoVersion: 2,
            projectEnv: {},
          },
          source: {
            kind: "database",
            ref: "postgresql://localhost/source",
            connectOptions: { isLocal: true, dnsResolver: "native" },
          },
          desired: {
            kind: "database",
            ref: "postgresql://localhost/desired",
            connectOptions: { isLocal: true, dnsResolver: "native" },
          },
          schema: [],
          formatOptions: "",
          debug: false,
          strictCoverage: false,
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(nextCalls).toBe(1);
      expect(legacyCalls).toBe(0);
    }).pipe(
      Effect.provide(
        legacyPgDeltaEngineSelectorLayer("true", { next, legacy }).pipe(
          Layer.provide(debugLayer(messages)),
        ),
      ),
    );
  });
});
