import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import { legacyPgDeltaNextEngineLayer } from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngine } from "./legacy-pgdelta-engine.service.ts";
import { LegacyPgDeltaNextAdapter } from "./legacy-pgdelta-next-adapter.service.ts";
import { LegacyPgDeltaNextShadow } from "./legacy-pgdelta-next-shadow.service.ts";
import type { LegacyDbTomlValues } from "../../../shared/legacy-db-config.toml-read.ts";

const common = {
  context: {
    projectId: "test",
    cwd: "/tmp/test",
    npmVersion: undefined,
    denoVersion: 2,
    projectEnv: {},
  },
  schema: ["public"],
  formatOptions: "",
  debug: false,
  strictCoverage: false,
} as const;

const toml: LegacyDbTomlValues = {
  projectEnv: {},
  envLookup: () => undefined,
  apiSchemas: ["public", "graphql_public"],
  port: 54322,
  shadowPort: 54320,
  password: "postgres",
  poolerConnectionString: Option.none(),
  projectId: Option.none(),
  majorVersion: 17,
  orioledbVersion: Option.none(),
  denoVersion: 2,
  pgDelta: {
    enabled: false,
    declarativeSchemaPath: Option.none(),
    formatOptions: Option.none(),
    npmVersion: Option.none(),
  },
  webhooksEnabled: false,
  baseline: {
    authEnabled: true,
    storageEnabled: true,
    realtimeEnabled: true,
    apiAutoExposeNewTables: Option.none(),
    vaultNames: [],
  },
  migrationsEnabled: true,
  schemaPaths: [],
  schemaPathPatterns: [],
  seed: { enabled: true, sqlPaths: [] },
  vault: [],
  appliedRemote: undefined,
  remoteOverrideKeys: new Set(),
};

function setup() {
  const state = { migrations: 0, plan: 0, planBypassCache: undefined as boolean | undefined };
  const shadow = Layer.succeed(LegacyPgDeltaNextShadow, {
    provisionMigrations: () =>
      Effect.sync(() => {
        state.migrations += 1;
      }).pipe(
        Effect.andThen(
          Effect.fail(new LegacyDeclarativeShadowDbError({ message: "stop after routing" })),
        ),
      ),
    provisionPlan: (opts) =>
      Effect.sync(() => {
        state.plan += 1;
        state.planBypassCache = opts.bypassCache;
      }).pipe(
        Effect.andThen(
          Effect.fail(new LegacyDeclarativeShadowDbError({ message: "stop after routing" })),
        ),
      ),
  });
  const unusedAdapter = Layer.succeed(LegacyPgDeltaNextAdapter, {
    diff: () => Effect.die("adapter not used"),
    exportDeclarativeSchema: () => Effect.die("adapter not used"),
    planDeclarativeSchema: () => Effect.die("adapter not used"),
    captureSnapshot: () => Effect.die("adapter not used"),
  });
  const debug = Layer.succeed(LegacyDebugLogger, {
    debug: () => Effect.void,
    http: () => Effect.void,
  });
  const dependencies = Layer.mergeAll(
    BunServices.layer,
    shadow,
    unusedAdapter,
    debug,
    mockOutput().layer,
  );
  return {
    state,
    layer: legacyPgDeltaNextEngineLayer.pipe(Layer.provide(dependencies)),
  };
}

describe("pg-delta next shadow selection", () => {
  it.effect("does not provision a second shadow for prepared database diffs", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* LegacyPgDeltaEngine;
      yield* engine
        .diffDatabase({
          ...common,
          source: {
            kind: "database",
            ref: "postgresql://postgres@localhost/source",
            connectOptions: { isLocal: true, dnsResolver: "native" },
          },
          target: {
            kind: "database",
            ref: "postgresql://postgres@localhost/postgres",
            connectOptions: { isLocal: true, dnsResolver: "native" },
          },
        })
        .pipe(Effect.exit);

      expect(state.migrations).toBe(0);
      expect(state.plan).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses only the migrated shadow for explicit migrations diffs", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* LegacyPgDeltaEngine;
      yield* engine
        .diffExplicit({
          ...common,
          toml,
          source: { kind: "migrations", projectRef: "linked-project" },
          desired: {
            kind: "database",
            ref: "postgresql://postgres@localhost/postgres",
            connectOptions: { isLocal: true, dnsResolver: "native" },
          },
        })
        .pipe(Effect.exit);

      expect(state.migrations).toBe(1);
      expect(state.plan).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses both isolated shadows for declarative plans", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* LegacyPgDeltaEngine;
      yield* engine
        .planDeclarativeSchema({
          ...common,
          toml,
          files: [{ name: "schema.sql", sql: "create table example(id int);" }],
          noCache: false,
          setupInputs: {
            image: "postgres:17",
            majorVersion: 17,
            authEnabled: true,
            storageEnabled: true,
            realtimeEnabled: true,
            autoExpose: false,
            vaultNames: [],
            rolesSql: "",
          },
        })
        .pipe(Effect.exit);

      expect(state.migrations).toBe(0);
      expect(state.plan).toBe(1);
      expect(state.planBypassCache).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards --no-cache as bypassCache on the declarative plan shadows", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* LegacyPgDeltaEngine;
      yield* engine
        .planDeclarativeSchema({
          ...common,
          toml,
          files: [{ name: "schema.sql", sql: "create table example(id int);" }],
          noCache: true,
          setupInputs: {
            image: "postgres:17",
            majorVersion: 17,
            authEnabled: true,
            storageEnabled: true,
            realtimeEnabled: true,
            autoExpose: false,
            vaultNames: [],
            rolesSql: "",
          },
        })
        .pipe(Effect.exit);

      expect(state.plan).toBe(1);
      expect(state.planBypassCache).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
