import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Effect, Exit, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";
import { applySchema } from "./apply-schema.ts";
import { digestVersions } from "./schema-digest.ts";
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
    coverageBlocked: false,
    renameBlocked: false,
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
    catalogMatch?: boolean;
    planChanges?: boolean;
  } = {},
) {
  const out = mockOutput({ interactive: false });
  let applyPending = 0;
  let marked = 0;
  let journaled = false;
  return {
    get applyPending() {
      return applyPending;
    },
    get marked() {
      return marked;
    },
    get journaled() {
      return journaled;
    },
    layer: Layer.mergeAll(
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
          listLocal: Effect.succeed([localFile]),
          createEmpty: () => Effect.die("unused"),
          writeGenerated: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        MigrationRunner,
        MigrationRunner.of({
          listRemote: () => Effect.succeed(opts.history ?? []),
          applyPending: () =>
            Effect.sync(() => {
              applyPending += 1;
              return { applied: [], skipped: [] };
            }),
          markApplied: () =>
            Effect.sync(() => {
              marked += 1;
            }),
        }),
      ),
      Layer.succeed(
        PgDeltaSchemaEngine,
        PgDeltaSchemaEngine.of({
          exportSchema: () => Effect.die("unused"),
          planFiles: () => Effect.succeed(planView(opts.planChanges === true)),
          diffPools: () => Effect.succeed(planView(opts.catalogMatch !== true)),
          applyPlan: () =>
            Effect.succeed({
              partial: false,
              report: {
                status: "applied",
                appliedActions: 0,
                actionStatuses: [],
              },
            }),
          provisionShadow: Effect.succeed({
            url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
          }),
        }),
      ),
    ),
  };
}

const flags = { yes: true, allowRemote: false } as const;

describe("applySchema", () => {
  it.live("runs pending SQL when the live catalog does not match full replay", () => {
    const ctx = setup();
    return Effect.gen(function* () {
      const result = yield* applySchema(flags).pipe(Effect.provide(ctx.layer));
      expect(result.status).toBe("clean");
      expect(ctx.applyPending).toBe(2);
      expect(ctx.marked).toBe(0);
      expect(ctx.journaled).toBe(false);
    });
  });

  it.live("marks history when the live catalog already matches full replay", () => {
    const ctx = setup({ catalogMatch: true });
    return Effect.gen(function* () {
      const result = yield* applySchema(flags).pipe(Effect.provide(ctx.layer));
      expect(result.status).toBe("clean");
      expect(result.message).toContain("Recorded");
      expect(ctx.marked).toBe(1);
    });
  });

  it.live("skips file apply while an ungenerated draft is active", () => {
    const ctx = setup({ journal: ungeneratedJournal });
    return Effect.gen(function* () {
      const result = yield* applySchema(flags).pipe(Effect.provide(ctx.layer));
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
      const exit = yield* applySchema(flags).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ctx.applyPending).toBe(0);
    });
  });

  it.live("journals a draft after applying declarations to the local database", () => {
    const ctx = setup({
      history: [{ version: localFile.version, name: localFile.name }],
      planChanges: true,
    });
    return Effect.gen(function* () {
      const result = yield* applySchema(flags).pipe(Effect.provide(ctx.layer));
      expect(result.status).toBe("draft");
      expect(result.mutatedDatabase).toBe(true);
      expect(ctx.journaled).toBe(true);
    });
  });
});
