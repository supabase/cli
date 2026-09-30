import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import type { DbTomlValues } from "../../../../command-internal/db-config.toml-read.ts";
import {
  PgDeltaEngine,
  type PgDeltaDeclarativePlanInput,
} from "../../shared/pgdelta-engine.service.ts";
import {
  type DeclarativeRunContext,
  diffDeclarativeToMigrations,
  generateDeclarativeOutput,
} from "./declarative.orchestrate.ts";

const ctx = (cwd: string, declarativeDir: string): DeclarativeRunContext => ({
  pgDelta: {
    projectId: "cferry",
    cwd,
    denoVersion: 2,
    projectEnv: {},
  },
  formatOptions: "",
  declarativeDir,
  declarativeDirDisplay: declarativeDir,
  schema: [],
  noCache: false,
  debug: false,
  strictCoverage: false,
  dnsResolver: "native",
});

// A minimal, valid `DbTomlValues` — matches `db-config.toml-read.ts`'s
// own unconfigured defaults so this fixture doesn't silently drift from what
// `readDbToml` would resolve for these tests' bare temp dirs (none of them
// write a `config.toml`).
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

function jsonParseErrorMessage(raw: string): string {
  try {
    JSON.parse(raw);
    return "";
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

describe("diffDeclarativeToMigrations", () => {
  it.effect("loads nested SQL and its manifest in stable order for the engine", () => {
    const calls: PgDeltaDeclarativePlanInput[] = [];
    const engine = Layer.succeed(
      PgDeltaEngine,
      PgDeltaEngine.of({
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema not used"),
        planDeclarativeSchema: (input) => {
          calls.push(input);
          return Effect.succeed({
            changes: true,
            sql: "ALTER TABLE public.accounts ALTER COLUMN email TYPE text;",
            files: [],
            sourceRef: "migrations",
            targetRef: "declarative",
            hazards: {
              actions: [{ actionIndex: 0, kinds: ["data_loss"] }],
              dataLoss: [
                {
                  actionIndex: 0,
                  sql: "ALTER TABLE public.accounts ALTER COLUMN email TYPE text;",
                },
              ],
              coverage: ["data_loss"],
              kinds: ["data_loss"],
            },
            removals: {
              extensions: ["pgcrypto"],
              extensionIntents: [
                { extension: "pg_cron", intentKind: "job", key: "refresh metrics" },
              ],
            },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "decl-orch-" });
      const declDir = path.join(dir, "supabase", "database");
      yield* fs.makeDirectory(path.join(declDir, "nested"), { recursive: true });
      yield* fs.writeFileString(path.join(declDir, "z.sql"), "select 'z';");
      yield* fs.writeFileString(path.join(declDir, "nested", "a.sql"), "select 'a';");
      yield* fs.writeFileString(path.join(declDir, "ignored.txt"), "ignored");
      yield* fs.writeFileString(
        path.join(declDir, ".pgdelta-export.json"),
        '{"formatVersion":1,"redactSecrets":true,"scope":"database"}',
      );
      const result = yield* diffDeclarativeToMigrations(
        { ...ctx(dir, declDir), debug: true, noCache: true, strictCoverage: true },
        toml,
      );
      expect(calls[0]?.files).toEqual([
        { name: "nested/a.sql", sql: "select 'a';" },
        { name: "z.sql", sql: "select 'z';" },
      ]);
      expect(calls[0]?.manifest).toEqual({ redactSecrets: true, scope: "database" });
      expect(calls[0]?.debug).toBe(true);
      expect(calls[0]?.noCache).toBe(true);
      expect(calls[0]?.strictCoverage).toBe(true);
      expect(result.manifestPresent).toBe(true);
      expect(result.dropWarnings).toEqual([
        "ALTER TABLE public.accounts ALTER COLUMN email TYPE text;",
      ]);
      expect(result.removals).toEqual({
        extensions: ["pgcrypto"],
        extensionIntents: [{ extension: "pg_cron", intentKind: "job", key: "refresh metrics" }],
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(engine, BunServices.layer)));
  });

  const stubEngine = (calls: PgDeltaDeclarativePlanInput[]) =>
    Layer.succeed(
      PgDeltaEngine,
      PgDeltaEngine.of({
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema not used"),
        planDeclarativeSchema: (input) => {
          calls.push(input);
          return Effect.succeed({
            changes: true,
            sql: "create table public.accounts();",
            files: [],
            sourceRef: "migrations",
            targetRef: "declarative",
          });
        },
      }),
    );

  it.effect("rejects a corrupt export manifest before planning", () => {
    const calls: PgDeltaDeclarativePlanInput[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "decl-orch-" });
      const declDir = path.join(dir, "supabase", "database");
      yield* fs.makeDirectory(declDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(declDir, "public.sql"),
        "create table public.accounts();",
      );
      yield* fs.writeFileString(path.join(declDir, ".pgdelta-export.json"), "{ not json at all");
      const exit = yield* diffDeclarativeToMigrations(ctx(dir, declDir), toml).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(String((error as { message?: string } | undefined)?.message)).toBe(
          `malformed export manifest ${path.join(declDir, ".pgdelta-export.json")}: ${jsonParseErrorMessage("{ not json at all")}`,
        );
      }
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(stubEngine(calls), BunServices.layer)));
  });

  it.effect("fails when the declarative dir is absent", () => {
    const calls: PgDeltaDeclarativePlanInput[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "decl-orch-" });
      const exit = yield* diffDeclarativeToMigrations(
        ctx(dir, path.join(dir, "missing")),
        toml,
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect((error as { message: string }).message).toContain(
          "No declarative schema directory found",
        );
      }
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(stubEngine(calls), BunServices.layer)));
  });
});

describe("generateDeclarativeOutput", () => {
  it.effect("propagates debug and strict coverage to the engine", () => {
    const calls: Array<{
      readonly debug: boolean;
      readonly strictCoverage: boolean;
    }> = [];
    const engine = Layer.succeed(
      PgDeltaEngine,
      PgDeltaEngine.of({
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: (input) => {
          calls.push({
            debug: input.debug,
            strictCoverage: input.strictCoverage,
          });
          return Effect.succeed({
            files: [],
            manifest: { redactSecrets: true, scope: "database" },
          });
        },
        planDeclarativeSchema: () => Effect.die("planDeclarativeSchema not used"),
      }),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "decl-export-" });
      yield* generateDeclarativeOutput(
        {
          ...ctx(dir, path.join(dir, "supabase", "database")),
          debug: true,
          noCache: true,
          strictCoverage: true,
        },
        {
          kind: "database",
          ref: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
      );
      expect(calls).toEqual([
        {
          debug: true,
          strictCoverage: true,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(engine, BunServices.layer)));
  });
});
