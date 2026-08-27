import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { formatHistoryConflict } from "../migrations/migration-repair-suggest.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";
import { applySchema } from "./apply-schema.ts";
import { SchemaEngineError, SchemaHistoryConflictError } from "./schema-errors.ts";
import { digestVersions } from "./schema-digest.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaApplyOutcome, SchemaDraftJournal, SchemaPlanView } from "./schema-types.ts";
import { SchemaWorkspace } from "./schema-workspace.service.ts";

function emptyPlan(): Plan {
  return {
    formatVersion: 1,
    engineVersion: "0.3.0",
    planId: "plan-1",
    source: { fingerprint: "source-fingerprint" },
    target: { fingerprint: "desired-fingerprint" },
    preamble: [],
    deltas: [],
    filteredDeltas: [],
    renameCandidates: [],
    actions: [],
    safetyReport: {
      destructiveActions: 0,
      rewriteRiskActions: 0,
      nonTransactionalActions: 0,
      lockClasses: {},
    },
  };
}

function planView(
  changes: boolean,
  extras: Partial<Pick<SchemaPlanView, "coverageBlocked" | "diagnostics" | "renameBlocked">> = {},
): SchemaPlanView {
  const plan = emptyPlan();
  return {
    planId: plan.planId,
    sourceFingerprint: plan.source.fingerprint,
    desiredFingerprint: plan.target.fingerprint,
    engineVersion: plan.engineVersion,
    profile: "supabase",
    changes,
    files: [],
    hazards: {
      kinds: [],
      destructive: 0,
      rewrite: 0,
      coverageGaps: 0,
      report: classifyPlanHazards(plan),
    },
    destructive: false,
    renameCandidates: [],
    acceptedRenames: [],
    coverageBlocked: extras.coverageBlocked ?? false,
    renameBlocked: extras.renameBlocked ?? false,
    diagnostics: extras.diagnostics ?? [],
    plan,
  };
}

const localFile = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: "select 1;",
  transactional: true,
};

const ungeneratedJournal: SchemaDraftJournal = {
  version: 1,
  draftId: "draft",
  targetIdentity: "local:default",
  startingMigrationHeadDigest: digestVersions([localFile.version]),
  sourceFingerprint: "s",
  engineVersion: "0.3.0",
  declarativelyAhead: true,
  generated: false,
  plans: [],
};

function setup(
  opts: {
    journal?: SchemaDraftJournal;
    history?: ReadonlyArray<{ version: string; name: string }>;
    files?: ReadonlyArray<typeof localFile>;
    catalogMatch?: boolean;
    installedExtensions?: ReadonlyArray<string>;
    liveServerVersion?: string;
    configMajor?: number;
    failApplying?: boolean;
    planChanges?: boolean;
    plan?: Partial<Pick<SchemaPlanView, "coverageBlocked" | "diagnostics" | "renameBlocked">>;
    applyPlan?: SchemaApplyOutcome;
  } = {},
) {
  const out = mockOutput({ interactive: false });
  let applyPending = 0;
  let marked = 0;
  let journaled = false;
  const liveApplied: string[] = [];
  const recorded = new Set((opts.history ?? []).map((row) => row.version));
  const configLayers =
    opts.configMajor === undefined
      ? Layer.empty
      : Layer.mergeAll(
          Path.layer,
          FileSystem.layerNoop({
            readFileString: () => Effect.succeed(`[db]\nmajor_version = ${opts.configMajor}\n`),
          }),
        );
  return {
    get applyPending() {
      return applyPending;
    },
    liveApplied,
    get marked() {
      return marked;
    },
    get journaled() {
      return journaled;
    },
    layer: Layer.mergeAll(
      configLayers,
      out.layer,
      Layer.succeed(
        DatabaseTargetResolver,
        DatabaseTargetResolver.of({
          resolve: () =>
            Effect.succeed({
              kind: "local",
              identity: "local:default",
              connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
              disposable: true,
              durable: false,
              connectionVerified: true,
            }),
        }),
      ),
      Layer.succeed(
        SchemaWorkspace,
        SchemaWorkspace.of({
          schemasDir: "/tmp/schemas",
          schemasDirDisplay: "supabase/schemas",
          migrationsDir: "/tmp/migrations",
          migrationsDirDisplay: "supabase/migrations",
          customDir: "/tmp/schemas/_custom",
          journalPath: "/tmp/j",
          lockPath: "/tmp/l",
          readDeclarationFiles: Effect.succeed([]),
          readExistingSql: () => Effect.succeed(new Map()),
          classifyProposed: () => Effect.die("unused"),
          installExport: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        SchemaStateStore,
        SchemaStateStore.of({
          readJournal: Effect.succeed(
            opts.journal === undefined ? Option.none() : Option.some(opts.journal),
          ),
          writeJournal: () =>
            Effect.sync(() => {
              journaled = true;
            }),
          clearJournal: Effect.void,
          withLock: (effect) => effect,
        }),
      ),
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed(opts.files ?? [localFile]),
          createEmpty: () => Effect.die("unused"),
          writeFetched: () => Effect.die("unused"),
          writeGenerated: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        MigrationRunner,
        MigrationRunner.of({
          listRemote: () => Effect.succeed(opts.history ?? []),
          listRemoteStatements: () => Effect.succeed([]),
          showServerVersion: () => Effect.succeed(opts.liveServerVersion),
          listInstalledExtensions: () => Effect.succeed(opts.installedExtensions ?? []),
          applyPending: (pool, files) =>
            Effect.gen(function* () {
              applyPending += 1;
              const conn = pool.options.connectionString ?? "";
              if (opts.failApplying === true && !conn.includes("54322")) {
                return yield* new SchemaEngineError({
                  detail: 'Failed applying migration: extension "pgjwt" already exists',
                  suggestion: "Check the database connection and migration SQL, then retry.",
                });
              }
              const leftover = files.filter((file) => !recorded.has(file.version));
              const remoteOnly = [...recorded].filter(
                (version) => !files.some((file) => file.version === version),
              );
              if (remoteOnly.length > 0 && leftover.length > 0) {
                return yield* new SchemaHistoryConflictError(
                  formatHistoryConflict({
                    remoteOnly,
                    pending: leftover.map((file) => file.version),
                    flags: { local: true },
                  }),
                );
              }
              if (conn.includes("54322")) {
                liveApplied.splice(0, liveApplied.length, ...leftover.map((file) => file.version));
              }
              return {
                applied: leftover.map((file) => file.version),
                skipped: files
                  .filter((file) => recorded.has(file.version))
                  .map((file) => file.version),
              };
            }),
          markApplied: (_pool, files) =>
            Effect.sync(() => {
              marked += 1;
              for (const file of files) recorded.add(file.version);
            }),
        }),
      ),
      Layer.succeed(
        PgDeltaSchemaEngine,
        PgDeltaSchemaEngine.of({
          exportSchema: () => Effect.die("unused"),
          planFiles: () => Effect.succeed(planView(opts.planChanges === true, opts.plan ?? {})),
          diffPools: () => Effect.succeed(planView(opts.catalogMatch !== true)),
          applyPlan: () =>
            Effect.succeed(
              opts.applyPlan ?? {
                partial: false,
                report: {
                  status: "applied",
                  appliedActions: 0,
                  actionStatuses: [],
                },
              },
            ),
          provisionPlatform: Effect.succeed({
            url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
          }),
          provisionShadow: Effect.succeed({
            url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
          }),
          provisionMigrations: Effect.die("unused"),
        }),
      ),
    ),
  };
}

describe("applySchema", () => {
  it.live("runs pending SQL when the live catalog does not match full replay", () => {
    const ctx = setup();
    return Effect.gen(function* () {
      const result = yield* applySchema().pipe(Effect.provide(ctx.layer));
      expect(result.status).toBe("clean");
      expect(ctx.applyPending).toBe(2);
      expect(ctx.marked).toBe(0);
      expect(ctx.journaled).toBe(false);
      expect(ctx.liveApplied).toEqual([localFile.version]);
    });
  });

  it.live("marks history when the live catalog already matches full replay", () => {
    const ctx = setup({ catalogMatch: true });
    return Effect.gen(function* () {
      const result = yield* applySchema().pipe(Effect.provide(ctx.layer));
      expect(result.status).toBe("clean");
      expect(result.message).toContain("Recorded");
      expect(ctx.marked).toBe(1);
    });
  });

  it.live("skips file apply while an ungenerated draft is active", () => {
    const ctx = setup({ journal: ungeneratedJournal });
    return Effect.gen(function* () {
      const result = yield* applySchema().pipe(Effect.provide(ctx.layer));
      expect(result.status).toBe("clean");
      expect(ctx.applyPending).toBe(0);
      expect(ctx.marked).toBe(0);
    });
  });

  it.live("fails closed when migration files change during an ungenerated draft", () => {
    const ctx = setup({
      journal: {
        ...ungeneratedJournal,
        startingMigrationHeadDigest: "not-the-current-head",
      },
    });
    return Effect.gen(function* () {
      const exit = yield* applySchema().pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ctx.applyPending).toBe(0);
    });
  });

  it.live("names the unmodeled object when planning is blocked", () => {
    const ctx = setup({
      history: [{ version: localFile.version, name: localFile.name }],
      plan: {
        coverageBlocked: true,
        diagnostics: [
          {
            code: "unmodeled_kind",
            severity: "warning",
            message:
              '1 unmodeled "cast" object not managed by this engine (e.g. public.widget AS integer)',
            context: { kind: "cast", count: 1, samples: ["public.widget AS integer"] },
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const exit = yield* applySchema().pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toMatchObject({
          _tag: "SchemaPlanningBlockedError",
          detail: expect.stringContaining("public.widget AS integer"),
          suggestion: expect.stringContaining("--debug"),
        });
      }
      expect(ctx.journaled).toBe(false);
    });
  });

  it.live("names the failing SQL when apply stops partway", () => {
    const ctx = setup({
      history: [{ version: localFile.version, name: localFile.name }],
      planChanges: true,
      applyPlan: {
        partial: true,
        report: {
          status: "failed",
          appliedActions: 0,
          actionStatuses: ["unapplied"],
          error: {
            actionIndex: 7,
            sql: 'DROP EXTENSION "pgcrypto"',
            message: "cannot drop extension pgcrypto because other objects depend on it",
          },
        },
      },
    });
    return Effect.gen(function* () {
      const exit = yield* applySchema().pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toMatchObject({
          _tag: "SchemaPartialApplyError",
          detail: expect.stringMatching(
            /cannot drop extension pgcrypto because other objects depend on it[\s\S]*DROP EXTENSION "pgcrypto"/,
          ),
          suggestion: expect.stringContaining("supabase db reset"),
        });
        expect(failure.value).toMatchObject({
          detail: expect.not.stringMatching(/plan|segment|in-doubt/i),
          suggestion: expect.not.stringMatching(/plan|segment|in-doubt|repair/i),
        });
      }
      expect(ctx.journaled).toBe(true);
    });
  });

  it.live("fails closed when the prefix scan cannot replay pending SQL", () => {
    const ctx = setup({ failApplying: true, planChanges: true });
    return Effect.gen(function* () {
      const exit = yield* applySchema().pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaEngineError);
        expect(failure.value.detail).toContain("pgjwt");
      }
      expect(ctx.journaled).toBe(false);
      expect(ctx.liveApplied).toEqual([]);
    });
  });

  it.live("refuses when the local Postgres major does not match config.toml", () => {
    const ctx = setup({
      liveServerVersion: "15.8",
      configMajor: 17,
      planChanges: true,
    });
    return Effect.gen(function* () {
      const exit = yield* applySchema().pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("PostgreSQL 15");
      expect(JSON.stringify(exit)).toContain("major_version is 17");
      expect(JSON.stringify(exit)).toContain("supabase db reset");
      expect(ctx.journaled).toBe(false);
      expect(ctx.applyPending).toBe(0);
    });
  });

  it.live("journals a draft after recording leftover pending that already matches", () => {
    const catchupFile = {
      version: "20260101000001",
      name: "catchup",
      fileName: "20260101000001_catchup.sql",
      absolutePath: "/tmp/migrations/20260101000001_catchup.sql",
      content: 'CREATE EXTENSION "pgjwt" SCHEMA "extensions";',
      transactional: true,
    };
    const ctx = setup({
      files: [localFile, catchupFile],
      history: [{ version: localFile.version, name: localFile.name }],
      installedExtensions: ["pgjwt"],
      planChanges: true,
    });
    return Effect.gen(function* () {
      const result = yield* applySchema().pipe(Effect.provide(ctx.layer));
      expect(result.status).toBe("draft");
      expect(ctx.journaled).toBe(true);
      expect(ctx.marked).toBe(1);
      expect(ctx.liveApplied).toEqual([]);
    });
  });

  it.live("journals a draft after applying declarations to the local database", () => {
    const ctx = setup({
      history: [{ version: localFile.version, name: localFile.name }],
      planChanges: true,
    });
    return Effect.gen(function* () {
      const result = yield* applySchema().pipe(Effect.provide(ctx.layer));
      expect(result.status).toBe("draft");
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.journaled).toBe(true);
      expect(result.message).toContain(
        "Applied locally and journaled. No migration files were written.",
      );
      expect(result.nextActions).toEqual([
        "to generate a migration: supabase schema generate --name <feature>",
      ]);
    });
  });
});
