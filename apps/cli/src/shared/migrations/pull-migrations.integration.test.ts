import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Effect, Layer } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import type { SchemaPlanView } from "../schema/schema-types.ts";
import { pullMigrations } from "./pull-migrations.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

function emptyPlan(): Plan {
  return {
    formatVersion: 1,
    engineVersion: "0.3.0",
    planId: "plan",
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

function setup(opts: { changes?: boolean } = {}) {
  const out = mockOutput({ interactive: false });
  return {
    layer: Layer.mergeAll(
      out.layer,
      Layer.succeed(
        DatabaseTargetResolver,
        DatabaseTargetResolver.of({
          resolve: () =>
            Effect.succeed({
              kind: "linked",
              identity: "abcdefghijklmnop",
              connectionString: "postgresql://postgres:secret@db.example/postgres",
              disposable: false,
              durable: true,
              connectionVerified: true,
              projectRef: "abcdefghijklmnop",
            }),
        }),
      ),
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed([]),
          createEmpty: () => Effect.die("unused"),
          writeGenerated: () =>
            Effect.succeed([
              {
                version: "20260819120000",
                name: "remote_schema",
                fileName: "20260819120000_remote_schema.sql",
                absolutePath: "/tmp/migrations/20260819120000_remote_schema.sql",
                content: "create table t (id int);",
                transactional: true,
              },
            ]),
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
          planFiles: () => Effect.die("unused"),
          diffPools: () => Effect.succeed(planView(opts.changes === true)),
          applyPlan: () => Effect.die("unused"),
          provisionShadow: Effect.succeed({
            url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
          }),
        }),
      ),
    ),
  };
}

describe("pullMigrations", () => {
  it.live("is a no-op when remote matches local replay", () => {
    const { layer } = setup({ changes: false });
    return Effect.gen(function* () {
      const result = yield* pullMigrations({}).pipe(Effect.provide(layer));
      expect(result.mutatedFiles).toBe(false);
      expect(result.nextActions).toEqual([]);
    });
  });

  it.live("suggests migration repair for the written versions", () => {
    const { layer } = setup({ changes: true });
    return Effect.gen(function* () {
      const result = yield* pullMigrations({}).pipe(Effect.provide(layer));
      expect(result.mutatedFiles).toBe(true);
      expect(result.nextActions.join("\n")).toContain(
        "supabase migration repair --status applied 20260819120000",
      );
    });
  });
});
