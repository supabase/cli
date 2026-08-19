import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";
import { pushMigrations } from "./push-migrations.ts";

const linked = {
  kind: "linked" as const,
  identity: "abcdefghijklmnop",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: false,
  projectRef: "abcdefghijklmnop",
};

function setup(opts: { declarations?: boolean; digestMatch?: boolean } = {}) {
  const out = mockOutput({ interactive: false });
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
        checkpointPath: "/tmp/schemas/.schema-checkpoint.json",
        journalPath: "/tmp/.supabase/schema-draft.json",
        lockPath: "/tmp/.supabase/schema.lock",
        readDeclarationFiles: Effect.succeed(
          opts.declarations === false ? [] : [{ name: "a.sql", sql: "create table a (id int);" }],
        ),
        readExistingSql: () => Effect.succeed(new Map()),
        classifyProposed: () => Effect.die("unused"),
        installExport: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      SchemaStateStore,
      SchemaStateStore.of({
        readCheckpoint: Effect.succeed(
          opts.digestMatch === true
            ? Option.some({
                version: 1 as const,
                declarativeDigest:
                  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                migrationHeadDigest: "b",
                profile: "supabase",
                scope: "database",
                engineVersion: "0.3.0",
                artifactFormatVersion: 1,
                acceptedRenames: [],
                generatedMigrationVersions: ["20260101000000"],
                lastGenerateHazards: { kinds: [], destructive: 0, rewrite: 0, coverageGaps: 0 },
              })
            : Option.none(),
        ),
        writeCheckpoint: () => Effect.void,
        readJournal: Effect.succeed(Option.none()),
        writeJournal: () => Effect.void,
        clearJournal: Effect.void,
        withLock: (effect) => effect,
      }),
    ),
    Layer.succeed(
      DatabaseTargetResolver,
      DatabaseTargetResolver.of({
        resolve: () => Effect.succeed(linked),
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
        recordApplied: () => Effect.void,
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
  );
  return { layer };
}

describe("pushMigrations", () => {
  it.live("fails closed when declarations are ahead of the checkpoint", () => {
    const { layer } = setup({ declarations: true, digestMatch: false });
    return Effect.gen(function* () {
      const exit = yield* pushMigrations({
        yes: true,
        allowDataLoss: true,
        allowRemote: false,
        projectRef: "abcdefghijklmnop",
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});
