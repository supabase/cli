import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { SchemaPlanFilesInput } from "./pg-delta-engine.service.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";
import { digestVersions } from "./schema-digest.ts";
import { generateSchema } from "./generate-schema.ts";
import { renderSchemaResult } from "./schema-render.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";
import {
  SchemaBaselineMigrationsExistError,
  SchemaEngineError,
  SchemaLinkedConnectionError,
} from "./schema-errors.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaDraftJournal, SchemaPlanView } from "./schema-types.ts";
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
  extras: Partial<Pick<SchemaPlanView, "coverageBlocked" | "diagnostics" | "renameBlocked">> & {
    readonly hazards?: Partial<SchemaPlanView["hazards"]>;
  } = {},
): SchemaPlanView {
  const plan = emptyPlan();
  return {
    planId: plan.planId,
    sourceFingerprint: plan.source.fingerprint,
    desiredFingerprint: plan.target.fingerprint,
    engineVersion: plan.engineVersion,
    profile: "supabase",
    changes,
    files: changes
      ? [
          {
            sequence: 1,
            suffix: null,
            sql: "create table t (id int);",
            transactional: true,
            actionCount: 1,
          },
        ]
      : [],
    hazards: {
      kinds: extras.hazards?.kinds ?? [],
      destructive: extras.hazards?.destructive ?? 0,
      rewrite: extras.hazards?.rewrite ?? 0,
      coverageGaps: extras.hazards?.coverageGaps ?? 0,
      report: extras.hazards?.report ?? classifyPlanHazards(plan),
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

const draftJournal: SchemaDraftJournal = {
  version: 1,
  draftId: "draft",
  targetIdentity: "local:default",
  startingMigrationHeadDigest: digestVersions(["20260101000000"]),
  sourceFingerprint: "s",
  engineVersion: "0.3.0",
  declarativelyAhead: true,
  generated: false,
  plans: [],
};

function setup(
  opts: {
    changes?: boolean;
    journal?: SchemaDraftJournal;
    write?: boolean;
    localMigrations?: "seeded" | "empty";
    remoteHistory?: ReadonlyArray<{ version: string; name: string }>;
    verifySql?: string;
    linked?: boolean;
    schemasDir?: string;
    plan?: Partial<Pick<SchemaPlanView, "coverageBlocked" | "diagnostics" | "renameBlocked">> & {
      readonly hazards?: Partial<SchemaPlanView["hazards"]>;
    };
  } = {},
) {
  const out = mockOutput({ interactive: false });
  let cleared = false;
  let planCalls = 0;
  let wrote = false;
  let shadowProvisions = 0;
  const planInputs: SchemaPlanFilesInput[] = [];
  const layer = Layer.mergeAll(
    out.layer,
    Layer.succeed(
      SchemaWorkspace,
      SchemaWorkspace.of({
        schemasDir: opts.schemasDir ?? "/tmp/schemas",
        schemasDirDisplay: "supabase/schemas",
        migrationsDir: "/tmp/migrations",
        migrationsDirDisplay: "supabase/migrations",
        customDir: "/tmp/schemas/_custom",
        journalPath: "/tmp/j",
        lockPath: "/tmp/l",
        readDeclarationFiles: Effect.succeed([{ name: "a.sql", sql: "create table a (id int);" }]),
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
        writeJournal: () => Effect.void,
        clearJournal: Effect.sync(() => {
          cleared = true;
        }),
        withLock: (effect) => effect,
      }),
    ),
    Layer.succeed(
      MigrationRepository,
      MigrationRepository.of({
        listLocal: Effect.succeed(
          opts.localMigrations === "empty"
            ? []
            : [
                {
                  version: "20260101000000",
                  name: "init",
                  fileName: "20260101000000_init.sql",
                  absolutePath: "/tmp/migrations/20260101000000_init.sql",
                  content: "select 1;",
                  transactional: true,
                },
              ],
        ),
        createEmpty: () => Effect.die("unused"),
        writeFetched: () => Effect.die("unused"),
        writeGenerated: () =>
          Effect.sync(() => {
            wrote = true;
          }).pipe(
            Effect.andThen(
              opts.write === true
                ? Effect.succeed([
                    {
                      version: "20260101000001",
                      name: "schema",
                      fileName: "20260101000001_schema.sql",
                      absolutePath: "/tmp/migrations/20260101000001_schema.sql",
                      content: "create table t (id int);",
                      transactional: true,
                    },
                  ])
                : Effect.die("unused"),
            ),
          ),
        remove: () => Effect.void,
      }),
    ),
    Layer.succeed(
      DatabaseTargetResolver,
      DatabaseTargetResolver.of({
        resolve: () =>
          opts.linked === true || opts.remoteHistory !== undefined
            ? Effect.succeed({
                kind: "linked" as const,
                identity: "abcdefghijklmnop",
                connectionString: "postgresql://postgres:secret@db.example/postgres",
                disposable: false,
                durable: true,
                connectionVerified: true,
                projectRef: "abcdefghijklmnop",
              })
            : Effect.fail(
                new SchemaLinkedConnectionError({
                  detail: "This project is not linked to a Supabase project.",
                  suggestion: "Run `supabase link`.",
                }),
              ),
      }),
    ),
    Layer.succeed(
      MigrationRunner,
      MigrationRunner.of({
        listRemote: () => Effect.succeed(opts.remoteHistory ?? []),
        listRemoteStatements: () => Effect.succeed([]),
        showServerVersion: () => Effect.succeed(undefined),
        listInstalledExtensions: () => Effect.die("unused"),
        applyPending: () => Effect.die("unused"),
        markApplied: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      PgDeltaSchemaEngine,
      PgDeltaSchemaEngine.of({
        exportSchema: () => Effect.die("unused"),
        planFiles: (input) =>
          Effect.sync(() => {
            planInputs.push(input);
            planCalls += 1;
            if (opts.write === true) {
              if (opts.verifySql !== undefined && planCalls > 1) {
                return {
                  ...planView(true),
                  files: [
                    {
                      sequence: 1,
                      suffix: null,
                      sql: opts.verifySql,
                      transactional: true,
                      actionCount: 1,
                    },
                  ],
                };
              }
              return planView(planCalls === 1);
            }
            return planView(opts.changes === true, opts.plan ?? {});
          }),
        diffPools: () => Effect.die("unused"),
        applyPlan: () => Effect.die("unused"),
        provisionShadow: Effect.sync(() => {
          shadowProvisions += 1;
          return {
            url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
          };
        }),
        provisionPlatform: Effect.die("unused"),
        provisionMigrations: Effect.sync(() => {
          shadowProvisions += 1;
          return {
            url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
          };
        }),
      }),
    ),
  );
  return {
    layer,
    out,
    get cleared() {
      return cleared;
    },
    get wrote() {
      return wrote;
    },
    get shadowProvisions() {
      return shadowProvisions;
    },
    planInputs,
  };
}

describe("generateSchema", () => {
  it.live("plans without a local database target and never records history", () => {
    const ctx = setup({ changes: false });
    return Effect.gen(function* () {
      const result = yield* generateSchema({ dryRun: true, baseline: false }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.mutatedDatabase).toBe(false);
      expect(result.mutatedFiles).toBe(false);
      expect(result.message).toContain("not the linked project");
      expect(ctx.cleared).toBe(false);
    });
  });

  it.live("forwards export loadOrder into planFiles", () => {
    const schemasDir = mkdtempSync(join(tmpdir(), "schema-generate-manifest-"));
    const loadOrder = ["public/tables/t.sql", "_cluster/publications.sql"];
    writeFileSync(
      join(schemasDir, ".pgdelta-export.json"),
      JSON.stringify({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        loadOrder,
      }),
    );
    const ctx = setup({ changes: false, schemasDir });
    return Effect.gen(function* () {
      yield* generateSchema({ dryRun: true, baseline: false }).pipe(Effect.provide(ctx.layer));
      expect(ctx.planInputs).toHaveLength(1);
      expect(ctx.planInputs[0]?.manifest?.loadOrder).toEqual(loadOrder);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(schemasDir, { recursive: true, force: true }))),
    );
  });

  it.live("clears a leftover draft when generate finds no changes", () => {
    const ctx = setup({ changes: false, journal: draftJournal });
    return Effect.gen(function* () {
      const result = yield* generateSchema({ dryRun: false, baseline: false }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.status).toBe("clean");
      expect(result.message).toContain("not the linked project");
      expect(result.mutatedFiles).toBe(false);
      expect(ctx.cleared).toBe(true);
    });
  });

  it.live("fails closed when migration files change during an ungenerated draft", () => {
    const ctx = setup({
      journal: {
        ...draftJournal,
        startingMigrationHeadDigest: "not-the-current-head",
      },
    });
    return Effect.gen(function* () {
      const exit = yield* generateSchema({ dryRun: true, baseline: false }).pipe(
        Effect.provide(ctx.layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ctx.cleared).toBe(false);
    });
  });

  it.live("points a dry-run with changes at the write command", () => {
    const ctx = setup({ changes: true, plan: { hazards: { destructive: 1 } } });
    return Effect.gen(function* () {
      const result = yield* generateSchema({ dryRun: true, baseline: false });
      expect(result.status).toBe("needs_approval");
      expect(result.message).toContain("Dry-run; nothing was written.");
      expect(result.message).toContain("1 statement");
      expect(result.message).toContain("Hazards:");
      expect(result.message).not.toContain("create table t");
      expect("body" in result ? result.body : undefined).toBe("create table t (id int);");
      expect(result.data).toEqual(
        expect.objectContaining({
          sql: "create table t (id int);",
          files: [expect.objectContaining({ sql: "create table t (id int);" })],
          hazards: expect.objectContaining({ destructive: 1 }),
        }),
      );
      expect(result.message).toContain(
        "Compared declarations vs migration replay on a local Postgres shadow, not the linked project.",
      );
      expect(result.nextActions).toEqual([
        "to write the migration: supabase schema generate --name <feature>",
      ]);
      yield* renderSchemaResult("Generate schema migrations", result);
      expect(ctx.out.stdoutText).toContain("create table t (id int);");
      expect(ctx.out.rawChunks).toHaveLength(1);
    }).pipe(Effect.provide(ctx.layer));
  });

  it.live("clears the draft journal after writing files", () => {
    const ctx = setup({ write: true, journal: draftJournal });
    return Effect.gen(function* () {
      const result = yield* generateSchema({ dryRun: false, baseline: false }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.mutatedFiles).toBe(true);
      expect(result.mutatedDatabase).toBe(false);
      expect(ctx.cleared).toBe(true);
      expect(result.message).toContain("Wrote supabase/migrations/20260101000001_schema.sql");
      expect(result.message).not.toContain("plan-1");
      expect(result.message).not.toContain("source-fingerprint");
      expect(result.nextActions).toEqual(["to deploy: supabase migrations push"]);
      expect(result.nextActions.join("\n")).not.toContain("migration repair");
      expect(result.data).toEqual(
        expect.objectContaining({
          sql: "create table t (id int);",
          files: [expect.objectContaining({ sql: "create table t (id int);" })],
        }),
      );
    });
  });

  it.live("suggests migration repair after writing a baseline", () => {
    const ctx = setup({ write: true, localMigrations: "empty" });
    return Effect.gen(function* () {
      const result = yield* generateSchema({ dryRun: false, baseline: true }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.nextActions.join("\n")).toContain(
        "supabase migration repair --status applied 20260101000001",
      );
    });
  });

  it.live("names privilege-only leftover when generated files do not converge", () => {
    const ctx = setup({
      write: true,
      verifySql: "GRANT EXECUTE ON FUNCTION public.accept_invitation() TO service_role;",
    });
    return Effect.gen(function* () {
      const exit = yield* generateSchema({ dryRun: false, baseline: false }).pipe(
        Effect.provide(ctx.layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaEngineError);
        expect(JSON.stringify(exit)).toContain("privileges only");
        expect(JSON.stringify(exit)).toContain("schema pull --force");
        expect(JSON.stringify(exit)).not.toContain("did not converge");
      }
      expect(ctx.wrote).toBe(true);
    });
  });

  it.live("fails closed when --baseline runs against remote history", () => {
    const ctx = setup({
      localMigrations: "empty",
      linked: true,
      remoteHistory: [{ version: "20260101000000", name: "alice" }],
    });
    return Effect.gen(function* () {
      const exit = yield* generateSchema({ dryRun: false, baseline: true }).pipe(
        Effect.provide(ctx.layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaBaselineMigrationsExistError);
        expect(JSON.stringify(exit)).toContain("migrations pull --from linked");
        expect(JSON.stringify(exit)).toContain("schema pull --from linked");
        expect(JSON.stringify(exit)).not.toContain("migration repair --status applied");
      }
      expect(ctx.wrote).toBe(false);
      expect(ctx.shadowProvisions).toBe(0);
    });
  });

  it.live("fails closed when --baseline runs against existing migration files", () => {
    const ctx = setup();
    return Effect.gen(function* () {
      const exit = yield* generateSchema({ dryRun: false, baseline: true }).pipe(
        Effect.provide(ctx.layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaBaselineMigrationsExistError);
        expect(failure.value._tag).toBe("SchemaBaselineMigrationsExistError");
      }
      expect(ctx.wrote).toBe(false);
      expect(ctx.shadowProvisions).toBe(0);
      expect(ctx.cleared).toBe(false);
    });
  });

  it.live("names coverage objects on dry-run without failing closed", () => {
    const ctx = setup({
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
      const result = yield* generateSchema({ dryRun: true, baseline: false }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.status).toBe("clean");
      expect(result.message).toContain("1 unmodeled cast (public.widget AS integer)");
      expect(ctx.cleared).toBe(false);
    });
  });

  it.live("fails closed when dry-run --baseline runs against existing migration files", () => {
    const ctx = setup();
    return Effect.gen(function* () {
      const exit = yield* generateSchema({ dryRun: true, baseline: true }).pipe(
        Effect.provide(ctx.layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaBaselineMigrationsExistError);
        expect(failure.value._tag).toBe("SchemaBaselineMigrationsExistError");
      }
      expect(ctx.wrote).toBe(false);
      expect(ctx.shadowProvisions).toBe(0);
    });
  });
});
