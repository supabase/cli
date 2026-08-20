import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import { SchemaEngineError } from "../schema/schema-errors.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import type { SchemaPlanView } from "../schema/schema-types.ts";
import { findMatchingPendingPrefix } from "./matching-pending-prefix.ts";
import type { MigrationFile } from "./migration-file.ts";
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

const first = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: "select 1;",
  transactional: true,
};

const second = {
  version: "20260101000001",
  name: "next",
  fileName: "20260101000001_next.sql",
  absolutePath: "/tmp/migrations/20260101000001_next.sql",
  content: "select 2;",
  transactional: true,
};

function historyPool(opts: { readonly failSql?: string } = {}): Pool {
  return {
    query: async (sql: string) => {
      if (opts.failSql !== undefined && sql === opts.failSql) {
        throw new Error("relation does not exist");
      }
      return { rows: [] };
    },
  } as Pool;
}

const engine = Layer.succeed(
  PgDeltaSchemaEngine,
  PgDeltaSchemaEngine.of({
    exportSchema: () => Effect.die("unused"),
    planFiles: () => Effect.die("unused"),
    diffPools: () => Effect.succeed(planView(false)),
    applyPlan: () => Effect.die("unused"),
    provisionShadow: Effect.die("unused"),
    provisionPlatform: Effect.die("unused"),
    provisionMigrations: Effect.die("unused"),
  }),
);

const runner = Layer.succeed(
  MigrationRunner,
  MigrationRunner.of({
    listRemote: () => Effect.succeed([]),
    applyPending: (pool, files: ReadonlyArray<MigrationFile>) =>
      Effect.gen(function* () {
        for (const file of files) {
          yield* Effect.tryPromise({
            try: () => pool.query(file.content),
            catch: (cause) =>
              new SchemaEngineError({
                detail: `Failed applying ${file.fileName}: ${cause instanceof Error ? cause.message : String(cause)}`,
                suggestion: "Check the migration SQL and retry.",
              }),
          });
        }
        return { applied: files.map((file) => file.version), skipped: [] };
      }),
    markApplied: () => Effect.void,
  }),
);

describe("findMatchingPendingPrefix", () => {
  it.live("applies a later pending file without treating known history as remote-only", () =>
    Effect.gen(function* () {
      const prefix = yield* findMatchingPendingPrefix(
        historyPool(),
        historyPool(),
        [first],
        [second],
      );
      expect(prefix.map((file) => file.version)).toEqual([second.version]);
    }).pipe(Effect.provide(Layer.mergeAll(runner, engine))),
  );

  it.live("stops the prefix scan when a later file cannot replay", () =>
    Effect.gen(function* () {
      const prefix = yield* findMatchingPendingPrefix(
        historyPool({ failSql: second.content }),
        historyPool(),
        [],
        [first, second],
      );
      expect(prefix.map((file) => file.version)).toEqual([first.version]);
    }).pipe(Effect.provide(Layer.mergeAll(runner, engine))),
  );
});
