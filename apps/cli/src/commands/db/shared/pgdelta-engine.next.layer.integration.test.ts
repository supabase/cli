import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { DeclarativeShadowDbError } from "./pgdelta.errors.ts";
import { pgDeltaNextEngineLayer } from "./pgdelta-engine.next.layer.ts";
import { PgDeltaEngine } from "./pgdelta-engine.service.ts";
import { PgDeltaNextAdapter } from "./pgdelta-next-adapter.service.ts";
import { PgDeltaNextShadow } from "./pgdelta-next-shadow.service.ts";
import type { DbTomlValues } from "../../../command-internal/db-config.toml-read.ts";

const common = {
  context: {
    projectId: "test",
    cwd: "/tmp/test",
    denoVersion: 2,
    projectEnv: {},
  },
  schema: ["public"],
  formatOptions: "",
  debug: false,
  strictCoverage: false,
} as const;

const toml: DbTomlValues = {
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
  const state = {
    migrations: 0,
    declarative: 0,
    plan: 0,
    declarativeBypassCache: undefined as boolean | undefined,
    planBypassCache: undefined as boolean | undefined,
  };
  const shadow = Layer.succeed(PgDeltaNextShadow, {
    provisionMigrations: () =>
      Effect.sync(() => {
        state.migrations += 1;
      }).pipe(
        Effect.andThen(
          Effect.fail(new DeclarativeShadowDbError({ message: "stop after routing" })),
        ),
      ),
    provisionDeclarative: (opts) =>
      Effect.sync(() => {
        state.declarative += 1;
        state.declarativeBypassCache = opts.bypassCache;
      }).pipe(
        Effect.andThen(
          Effect.fail(new DeclarativeShadowDbError({ message: "stop after routing" })),
        ),
      ),
    provisionPlan: (opts) =>
      Effect.sync(() => {
        state.plan += 1;
        state.planBypassCache = opts.bypassCache;
      }).pipe(
        Effect.andThen(
          Effect.fail(new DeclarativeShadowDbError({ message: "stop after routing" })),
        ),
      ),
  });
  const unusedAdapter = Layer.succeed(PgDeltaNextAdapter, {
    diff: () => Effect.die("adapter not used"),
    exportDeclarativeSchema: () => Effect.die("adapter not used"),
    planDeclarativeSchema: () => Effect.die("adapter not used"),
    captureSnapshot: () => Effect.die("adapter not used"),
  });
  const debug = Layer.succeed(DebugLogger, {
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
    layer: pgDeltaNextEngineLayer.pipe(Layer.provide(dependencies)),
  };
}

describe("pg-delta next shadow selection", () => {
  it.effect("does not provision a second shadow for prepared database diffs", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* PgDeltaEngine;
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
      expect(state.declarative).toBe(0);
      expect(state.plan).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses only the migrated shadow for explicit migrations diffs", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* PgDeltaEngine;
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
      expect(state.declarative).toBe(0);
      expect(state.plan).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses both isolated shadows for declarative plans", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* PgDeltaEngine;
      yield* engine
        .planDeclarativeSchema({
          ...common,
          toml,
          files: [{ name: "schema.sql", sql: "create table example(id int);" }],
          noCache: false,
        })
        .pipe(Effect.exit);

      expect(state.migrations).toBe(0);
      expect(state.declarative).toBe(0);
      expect(state.plan).toBe(1);
      expect(state.planBypassCache).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses only the declarative shadow when planning from a live database", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* PgDeltaEngine;
      yield* engine
        .planDeclarativeSchema({
          ...common,
          toml,
          source: {
            kind: "database",
            ref: "postgresql://postgres:secret@localhost/postgres",
            connectOptions: { isLocal: true, dnsResolver: "native" },
          },
          files: [{ name: "schema.sql", sql: "create table example(id int);" }],
          noCache: true,
        })
        .pipe(Effect.exit);

      expect(state.migrations).toBe(0);
      expect(state.declarative).toBe(1);
      expect(state.declarativeBypassCache).toBe(true);
      expect(state.plan).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards --no-cache as bypassCache on the declarative plan shadows", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const engine = yield* PgDeltaEngine;
      yield* engine
        .planDeclarativeSchema({
          ...common,
          toml,
          files: [{ name: "schema.sql", sql: "create table example(id int);" }],
          noCache: true,
        })
        .pipe(Effect.exit);

      expect(state.plan).toBe(1);
      expect(state.planBypassCache).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
