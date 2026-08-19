import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { applySchema } from "../../../../shared/schema/apply-schema.ts";
import { DatabaseTargetResolver } from "../../../../shared/database/database-target.service.ts";
import { SchemaStateStore } from "../../../../shared/schema/schema-state.service.ts";
import { SchemaWorkspace } from "../../../../shared/schema/schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "../../../../shared/schema/pg-delta-engine.service.ts";
import { MigrationRepository } from "../../../../shared/migrations/migration-repository.service.ts";
import { MigrationRunner } from "../../../../shared/migrations/migration-runner.service.ts";
import { Option } from "effect";

function setup(disposable: boolean) {
  const out = mockOutput({ interactive: false });
  return {
    layer: Layer.mergeAll(
      out.layer,
      Layer.succeed(
        DatabaseTargetResolver,
        DatabaseTargetResolver.of({
          resolve: () =>
            Effect.succeed({
              kind: disposable ? "local" : "linked",
              identity: disposable ? "local:default" : "abcdefghijklmnop",
              connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
              disposable,
              durable: !disposable,
              connectionVerified: disposable,
              ...(disposable ? {} : { projectRef: "abcdefghijklmnop" }),
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
          checkpointPath: "/tmp/c",
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
          readCheckpoint: Effect.succeed(Option.none()),
          writeCheckpoint: () => Effect.void,
          readJournal: Effect.succeed(Option.none()),
          writeJournal: () => Effect.void,
          clearJournal: Effect.void,
          withLock: (effect) => effect,
        }),
      ),
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.succeed([]),
          createEmpty: () => Effect.die("unused"),
          writeGenerated: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        MigrationRunner,
        MigrationRunner.of({
          listRemote: () => Effect.succeed([]),
          applyPending: () => Effect.succeed({ applied: [], skipped: [] }),
          markApplied: () => Effect.void,
        }),
      ),
      Layer.succeed(
        PgDeltaSchemaEngine,
        PgDeltaSchemaEngine.of({
          exportSchema: () => Effect.die("unused"),
          planFiles: () => Effect.die("unused"),
          diffPools: () => Effect.die("unused"),
          applyPlan: () => Effect.die("unused"),
          provisionShadow: Effect.die("unused"),
        }),
      ),
    ),
  };
}

describe("applySchema", () => {
  it.live("refuses durable remote targets", () => {
    const { layer } = setup(false);
    return Effect.gen(function* () {
      const exit = yield* applySchema({
        yes: true,
        allowRemote: true,
        projectRef: "abcdefghijklmnop",
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});
