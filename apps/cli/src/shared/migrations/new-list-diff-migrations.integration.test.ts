import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { Effect, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import type { SchemaPlanView } from "../schema/schema-types.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { diffMigrations } from "./diff-migrations.ts";
import { listMigrations } from "./list-migrations.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";
import { newMigration } from "./new-migration.ts";

const file = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: "select 1;",
  transactional: true,
};

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

const workspace = Layer.succeed(
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
);

const state = Layer.succeed(
  SchemaStateStore,
  SchemaStateStore.of({
    readJournal: Effect.succeed(Option.none()),
    writeJournal: () => Effect.void,
    clearJournal: Effect.void,
    withLock: (effect) => effect,
  }),
);

const localTarget = Layer.succeed(
  DatabaseTargetResolver,
  DatabaseTargetResolver.of({
    resolve: () =>
      Effect.succeed({
        kind: "local",
        identity: "local:default",
        connectionString: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
        disposable: true,
        durable: false,
        connectionVerified: true,
      }),
  }),
);

describe("newMigration", () => {
  it.live("writes an empty migration file", () => {
    const created = { ...file, name: "add_billing", fileName: "20260101000000_add_billing.sql" };
    const layer = Layer.mergeAll(
      mockOutput({ interactive: false }).layer,
      workspace,
      state,
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed([]),
          createEmpty: () => Effect.succeed(created),
          writeGenerated: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const result = yield* newMigration("add_billing").pipe(Effect.provide(layer));
      expect(result.mutatedFiles).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({ file: created.fileName, version: created.version }),
      );
    });
  });
});

describe("listMigrations", () => {
  it.live("compares local files against remote history", () => {
    const layer = Layer.mergeAll(
      mockOutput({ interactive: false }).layer,
      localTarget,
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed([file]),
          createEmpty: () => Effect.die("unused"),
          writeGenerated: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        MigrationRunner,
        MigrationRunner.of({
          listRemote: () => Effect.succeed([{ version: file.version, name: file.name }]),
          applyPending: () => Effect.die("unused"),
          markApplied: () => Effect.die("unused"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const result = yield* listMigrations({ against: "local" }).pipe(Effect.provide(layer));
      expect(result.data).toEqual(
        expect.objectContaining({
          migrations: [{ version: file.version, name: file.name, local: true, remote: true }],
        }),
      );
    });
  });
});

describe("diffMigrations", () => {
  it.live("previews drift against the named target", () => {
    const layer = Layer.mergeAll(
      mockOutput({ interactive: false }).layer,
      localTarget,
      Layer.succeed(
        PgDeltaSchemaEngine,
        PgDeltaSchemaEngine.of({
          exportSchema: () => Effect.die("unused"),
          planFiles: () => Effect.die("unused"),
          diffPools: () => Effect.succeed(planView(true)),
          applyPlan: () => Effect.die("unused"),
          provisionShadow: Effect.die("unused"),
          provisionMigrations: Effect.succeed({
            url: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
          }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const result = yield* diffMigrations({ against: "local" }).pipe(
        Effect.provide(layer),
        Effect.provide(BunServices.layer),
      );
      expect(result.status).toBe("drift");
      expect(result.mutatedDatabase).toBe(false);
    });
  });
});
