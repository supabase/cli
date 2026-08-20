import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Effect, Exit, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import type { SchemaDraftJournal, SchemaPlanView } from "../schema/schema-types.ts";
import { applyMigrations } from "./apply-migrations.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

const ungeneratedAheadJournal: SchemaDraftJournal = {
  version: 1,
  draftId: "draft",
  targetIdentity: "local:default",
  startingMigrationHeadDigest: "abc",
  sourceFingerprint: "s",
  engineVersion: "0.3.0",
  declarativelyAhead: true,
  generated: false,
  plans: [],
};

function emptyPlan(): Plan {
  return {
    formatVersion: 1,
    engineVersion: "0.3.0",
    planId: "plan-1",
    source: { fingerprint: "s" },
    target: { fingerprint: "d" },
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
    diagnostics: [],
    plan,
  };
}

const laterFile = {
  version: "20260101000001",
  name: "next",
  fileName: "20260101000001_next.sql",
  absolutePath: "/tmp/migrations/20260101000001_next.sql",
  content: "select 2;",
  transactional: true,
};

function setup(
  journal: SchemaDraftJournal | undefined,
  opts: {
    history?: ReadonlyArray<{ version: string; name: string }>;
    catalogMatch?: boolean;
    catalogMatches?: ReadonlyArray<boolean>;
    files?: ReadonlyArray<{
      version: string;
      name: string;
      fileName: string;
      absolutePath: string;
      content: string;
      transactional: boolean;
    }>;
  } = {},
) {
  const out = mockOutput({ interactive: false });
  let applyPending = 0;
  let marked = 0;
  let diffCalls = 0;
  return {
    get applyPending() {
      return applyPending;
    },
    get marked() {
      return marked;
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
        SchemaStateStore,
        SchemaStateStore.of({
          readJournal: Effect.succeed(journal === undefined ? Option.none() : Option.some(journal)),
          writeJournal: () => Effect.void,
          clearJournal: Effect.void,
          withLock: (effect) => effect,
        }),
      ),
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed(
            opts.files ?? [
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
          planFiles: () => Effect.die("unused"),
          diffPools: () => {
            const match =
              opts.catalogMatches !== undefined
                ? opts.catalogMatches[diffCalls] === true
                : opts.catalogMatch === true;
            diffCalls += 1;
            return Effect.succeed(planView(!match));
          },
          applyPlan: () => Effect.die("unused"),
          provisionShadow: Effect.die("unused"),
          provisionPlatform: Effect.succeed({
            url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
          }),
          provisionMigrations: Effect.die("unused"),
        }),
      ),
    ),
  };
}

describe("applyMigrations", () => {
  it.live("fails closed when an ungenerated draft is active", () => {
    const ctx = setup(ungeneratedAheadJournal);
    return Effect.gen(function* () {
      const exit = yield* applyMigrations().pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ctx.applyPending).toBe(0);
      expect(ctx.marked).toBe(0);
    });
  });

  it.live("runs pending SQL when the live catalog does not match full replay", () => {
    const ctx = setup(undefined);
    return Effect.gen(function* () {
      const result = yield* applyMigrations().pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(false);
      expect(ctx.applyPending).toBe(2);
      expect(ctx.marked).toBe(0);
    });
  });

  it.live("marks history when the live catalog already matches full replay", () => {
    const ctx = setup(undefined, { catalogMatch: true });
    return Effect.gen(function* () {
      const result = yield* applyMigrations().pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(true);
      expect(result.message).toContain("Recorded");
      expect(ctx.marked).toBe(1);
    });
  });

  it.live("records a matching prefix then runs the remaining pending SQL", () => {
    const ctx = setup(undefined, {
      files: [
        {
          version: "20260101000000",
          name: "init",
          fileName: "20260101000000_init.sql",
          absolutePath: "/tmp/migrations/20260101000000_init.sql",
          content: "select 1;",
          transactional: true,
        },
        laterFile,
      ],
      catalogMatches: [true, false],
    });
    return Effect.gen(function* () {
      const result = yield* applyMigrations().pipe(Effect.provide(ctx.layer));
      expect(result.message).toContain("Recorded");
      expect(ctx.marked).toBe(1);
      expect(ctx.applyPending).toBe(3);
    });
  });

  it.live("fails closed when history has remote-only versions and pending files", () => {
    const ctx = setup(undefined, {
      history: [{ version: "19990101000000", name: "other" }],
    });
    return Effect.gen(function* () {
      const exit = yield* applyMigrations().pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "supabase migration repair --local --status reverted 19990101000000",
      );
      expect(ctx.applyPending).toBe(0);
      expect(ctx.marked).toBe(0);
    });
  });

  it.live("is a no-op when every local version is already in history", () => {
    const ctx = setup(undefined, {
      history: [{ version: "20260101000000", name: "init" }],
    });
    return Effect.gen(function* () {
      const result = yield* applyMigrations().pipe(Effect.provide(ctx.layer));
      expect(result.mutatedDatabase).toBe(false);
      expect(ctx.applyPending).toBe(0);
      expect(ctx.marked).toBe(0);
    });
  });
});
