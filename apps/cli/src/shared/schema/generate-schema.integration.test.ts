import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Effect, Exit, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";
import { digestVersions } from "./schema-digest.ts";
import { generateSchema } from "./generate-schema.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";
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

function planView(changes: boolean): SchemaPlanView {
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
      kinds: [],
      destructive: 0,
      rewrite: 0,
      coverageGaps: 0,
      report: classifyPlanHazards(plan),
    },
    destructive: false,
    renameCandidates: [],
    acceptedRenames: [],
    coverageBlocked: false,
    renameBlocked: false,
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

function setup(opts: { changes?: boolean; journal?: SchemaDraftJournal; write?: boolean } = {}) {
  const out = mockOutput({ interactive: false });
  let cleared = false;
  let planCalls = 0;
  const layer = Layer.mergeAll(
    out.layer,
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
        listLocal: Effect.succeed([
          {
            version: "20260101000000",
            name: "init",
            fileName: "20260101000000_init.sql",
            absolutePath: "/tmp/migrations/20260101000000_init.sql",
            content: "select 1;",
            transactional: true,
          },
        ]),
        createEmpty: () => Effect.die("unused"),
        writeGenerated: () =>
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
        remove: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      MigrationRunner,
      MigrationRunner.of({
        listRemote: () => Effect.succeed([]),
        applyPending: () => Effect.succeed({ applied: [], skipped: [] }),
        markApplied: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      PgDeltaSchemaEngine,
      PgDeltaSchemaEngine.of({
        exportSchema: () => Effect.die("unused"),
        planFiles: () =>
          Effect.sync(() => {
            planCalls += 1;
            if (opts.write === true) {
              return planView(planCalls === 1);
            }
            return planView(opts.changes === true);
          }),
        diffPools: () => Effect.die("unused"),
        applyPlan: () => Effect.die("unused"),
        provisionShadow: Effect.succeed({
          url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
        }),
      }),
    ),
  );
  return {
    layer,
    get cleared() {
      return cleared;
    },
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
      expect(ctx.cleared).toBe(false);
    });
  });

  it.live("clears a leftover draft when generate finds no changes", () => {
    const ctx = setup({ changes: false, journal: draftJournal });
    return Effect.gen(function* () {
      const result = yield* generateSchema({ dryRun: false, baseline: false }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.status).toBe("clean");
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

  it.live("clears the draft journal after writing files", () => {
    const ctx = setup({ write: true, journal: draftJournal });
    return Effect.gen(function* () {
      const result = yield* generateSchema({ dryRun: false, baseline: false }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.mutatedFiles).toBe(true);
      expect(result.mutatedDatabase).toBe(false);
      expect(ctx.cleared).toBe(true);
      expect(result.nextActions.join("\n")).not.toContain("migration repair");
    });
  });

  it.live("suggests migration repair after writing a baseline", () => {
    const ctx = setup({ write: true });
    return Effect.gen(function* () {
      const result = yield* generateSchema({ dryRun: false, baseline: true }).pipe(
        Effect.provide(ctx.layer),
      );
      expect(result.nextActions.join("\n")).toContain(
        "supabase migration repair --status applied 20260101000001",
      );
    });
  });
});
