import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import type { LegacyDbTomlValues } from "../../../../command-internal/legacy-db-config.toml-read.ts";
import {
  LegacyPgDeltaEngine,
  type LegacyPgDeltaDeclarativePlanInput,
  LegacyPgDeltaEngineError,
} from "../../shared/legacy-pgdelta-engine.service.ts";
import { LegacyDeclarativeCompatibilityError } from "./declarative.errors.ts";
import {
  type LegacyDeclarativeRunContext,
  legacyDiffDeclarativeToMigrations,
  legacyGenerateDeclarativeOutput,
  legacyPlanDeclarativeToDatabase,
} from "./declarative.orchestrate.ts";

const ctx = (cwd: string, declarativeDir: string): LegacyDeclarativeRunContext => ({
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

// A minimal, valid `LegacyDbTomlValues` — matches `legacy-db-config.toml-read.ts`'s
// own unconfigured defaults so this fixture doesn't silently drift from what
// `legacyReadDbToml` would resolve for these tests' bare temp dirs (none of them
// write a `config.toml`).
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

describe("legacyDiffDeclarativeToMigrations", () => {
  it.effect("loads nested SQL and its manifest in stable order for the engine", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(join(declDir, "nested"), { recursive: true });
    writeFileSync(join(declDir, "z.sql"), "select 'z';");
    writeFileSync(join(declDir, "nested", "a.sql"), "select 'a';");
    writeFileSync(join(declDir, "ignored.txt"), "ignored");
    writeFileSync(
      join(declDir, ".pgdelta-export.json"),
      JSON.stringify({ formatVersion: 1, redactSecrets: true, scope: "database" }),
    );
    const calls: LegacyPgDeltaDeclarativePlanInput[] = [];
    const engine = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
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
    return legacyDiffDeclarativeToMigrations(
      { ...ctx(dir, declDir), debug: true, noCache: true, strictCoverage: true },
      toml,
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
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
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(Layer.mergeAll(engine, BunServices.layer)),
    );
  });

  const stubEngine = (calls: LegacyPgDeltaDeclarativePlanInput[]) =>
    Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
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
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "public.sql"), "create table public.accounts();");
    writeFileSync(join(declDir, ".pgdelta-export.json"), "{ not json at all");
    const calls: LegacyPgDeltaDeclarativePlanInput[] = [];
    return legacyDiffDeclarativeToMigrations(ctx(dir, declDir), toml).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
            expect(String((error as { message?: string } | undefined)?.message)).toContain(
              "malformed export manifest",
            );
          }
          expect(calls).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(Layer.mergeAll(stubEngine(calls), BunServices.layer)),
    );
  });

  it.effect("fails when the declarative dir is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const calls: LegacyPgDeltaDeclarativePlanInput[] = [];
    return legacyDiffDeclarativeToMigrations(ctx(dir, join(dir, "missing")), toml).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
            expect((error as { message: string }).message).toContain(
              "No declarative schema directory found",
            );
          }
          expect(calls).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(Layer.mergeAll(stubEngine(calls), BunServices.layer)),
    );
  });
});

describe("legacyPlanDeclarativeToDatabase", () => {
  it.effect("forwards the database source through the shared planning path", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "public.sql"), "drop table public.accounts;");
    const calls: LegacyPgDeltaDeclarativePlanInput[] = [];
    const engine = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema not used"),
        planDeclarativeSchema: (input) => {
          calls.push(input);
          return Effect.succeed({
            changes: true,
            sql: "drop table public.accounts;",
            files: [],
            sourceRef: "pg-delta-next:database",
            targetRef: "pg-delta-next:declarative",
          });
        },
      }),
    );
    const source = {
      kind: "database" as const,
      ref: "postgresql://postgres:secret@localhost/postgres",
      connectOptions: { isLocal: true, dnsResolver: "native" as const },
    };

    return legacyPlanDeclarativeToDatabase(ctx(dir, declDir), toml, source).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(calls).toHaveLength(1);
          expect(calls[0]?.source).toBe(source);
          expect(calls[0]?.files).toEqual([
            { name: "public.sql", sql: "drop table public.accounts;" },
          ]);
          expect(result).toMatchObject({
            diffSQL: "drop table public.accounts;",
            sourceRef: "pg-delta-next:database",
            targetRef: "pg-delta-next:declarative",
            manifestPresent: false,
            removals: { extensions: [], extensionIntents: [] },
          });
          expect(result.sourceRef).not.toContain("secret");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(Layer.mergeAll(engine, BunServices.layer)),
    );
  });

  it.effect("maps declarative load failures through the shared compatibility gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "members.sql"), "select extensions.uuid_generate_v4();");
    const engine = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema not used"),
        planDeclarativeSchema: () =>
          Effect.fail(
            new LegacyPgDeltaEngineError({
              message: "declarative load did not converge",
              cause: "load failed",
              diagnostics: [
                {
                  code: "max_rounds_exceeded",
                  severity: "error",
                  message: "members.sql: function extensions.uuid_generate_v4() does not exist",
                },
              ],
            }),
          ),
      }),
    );
    const source = {
      kind: "database" as const,
      ref: "postgresql://postgres@localhost/postgres",
      connectOptions: { isLocal: true, dnsResolver: "native" as const },
    };

    return legacyPlanDeclarativeToDatabase(ctx(dir, declDir), toml, source).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(LegacyDeclarativeCompatibilityError);
          if (error instanceof LegacyDeclarativeCompatibilityError) {
            expect(error.loadFindings).toEqual([
              expect.objectContaining({
                extension: "uuid-ossp",
                file: "members.sql",
                line: 1,
              }),
            ]);
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(Layer.mergeAll(engine, BunServices.layer)),
    );
  });
});

describe("legacyGenerateDeclarativeOutput", () => {
  it.effect("propagates debug and strict coverage to the engine", () => {
    const calls: Array<{
      readonly debug: boolean;
      readonly strictCoverage: boolean;
    }> = [];
    const engine = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
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
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-export-"));
    return legacyGenerateDeclarativeOutput(
      {
        ...ctx(dir, join(dir, "supabase", "database")),
        debug: true,
        noCache: true,
        strictCoverage: true,
      },
      {
        kind: "database",
        ref: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        connectOptions: { isLocal: true, dnsResolver: "native" },
      },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls).toEqual([
            {
              debug: true,
              strictCoverage: true,
            },
          ]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(Layer.mergeAll(engine, BunServices.layer)),
    );
  });
});
