import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { newMigration } from "../../../../shared/migrations/new-migration.ts";
import { MigrationRepository } from "../../../../shared/migrations/migration-repository.service.ts";
import { migrationRepositoryLayer } from "../../../../shared/migrations/migration-repository.layer.ts";
import { schemaStateLayer } from "../../../../shared/schema/schema-state.layer.ts";
import { schemaWorkspaceLayer } from "../../../../shared/schema/schema-workspace.layer.ts";

describe("newMigration", () => {
  it.live("creates a timestamped migration file", () => {
    const root = mkdtempSync(join(tmpdir(), "migrations-new-"));
    const supabaseDir = join(root, "supabase");
    const projectHomeDir = join(root, ".supabase");
    mkdirSync(supabaseDir, { recursive: true });
    mkdirSync(projectHomeDir, { recursive: true });
    const workspace = schemaWorkspaceLayer({
      projectRoot: root,
      supabaseDir,
      projectHomeDir,
    }).pipe(Layer.provide(BunServices.layer));
    const out = mockOutput({ format: "json" });
    const layer = Layer.mergeAll(
      out.layer,
      BunServices.layer,
      workspace,
      schemaStateLayer.pipe(Layer.provide(workspace), Layer.provide(BunServices.layer)),
      migrationRepositoryLayer.pipe(Layer.provide(workspace), Layer.provide(BunServices.layer)),
    );

    return Effect.gen(function* () {
      const result = yield* newMigration("add_billing").pipe(Effect.provide(layer));
      expect(result.mutatedFiles).toBe(true);
      const files = readdirSync(join(supabaseDir, "migrations"));
      expect(files.some((name) => name.endsWith("_add_billing.sql"))).toBe(true);
      expect(existsSync(join(supabaseDir, "migrations", files[0]!))).toBe(true);
    });
  });

  it.live("assigns a unique version to each generated plan unit", () => {
    const root = mkdtempSync(join(tmpdir(), "migrations-units-"));
    const supabaseDir = join(root, "supabase");
    const projectHomeDir = join(root, ".supabase");
    mkdirSync(supabaseDir, { recursive: true });
    mkdirSync(projectHomeDir, { recursive: true });
    const workspace = schemaWorkspaceLayer({
      projectRoot: root,
      supabaseDir,
      projectHomeDir,
    }).pipe(Layer.provide(BunServices.layer));
    const layer = Layer.mergeAll(
      mockOutput({ format: "json" }).layer,
      BunServices.layer,
      workspace,
      schemaStateLayer.pipe(Layer.provide(workspace), Layer.provide(BunServices.layer)),
      migrationRepositoryLayer.pipe(Layer.provide(workspace), Layer.provide(BunServices.layer)),
    );

    return Effect.gen(function* () {
      const written = yield* Effect.gen(function* () {
        const repository = yield* MigrationRepository;
        return yield* repository.writeGenerated({
          name: "split_plan",
          baseMillis: Date.parse("2026-01-01T00:00:00.000Z"),
          files: [
            { suffix: null, sql: "create table a (id int);\n", transactional: true },
            { suffix: "nt", sql: "grant select on a to anon;\n", transactional: false },
          ],
        });
      }).pipe(Effect.provide(layer));
      expect(written.map((file) => file.version)).toEqual(["20260101000000", "20260101000001"]);
      expect(written.map((file) => file.fileName)).toEqual([
        "20260101000000_split_plan.sql",
        "20260101000001_split_plan_nt.sql",
      ]);
    });
  });

  it.live("refuses to create a migration while a declarative draft is active", () => {
    const root = mkdtempSync(join(tmpdir(), "migrations-draft-"));
    const supabaseDir = join(root, "supabase");
    const projectHomeDir = join(root, ".supabase");
    mkdirSync(supabaseDir, { recursive: true });
    mkdirSync(projectHomeDir, { recursive: true });
    writeFileSync(
      join(projectHomeDir, "schema-draft.json"),
      `${JSON.stringify(
        {
          version: 1,
          draftId: "draft-1",
          targetIdentity: "local:default",
          startingMigrationHeadDigest: "abc",
          sourceFingerprint: "def",
          plans: [],
          engineVersion: "0.3.0",
          declarativelyAhead: true,
          generated: false,
        },
        null,
        2,
      )}\n`,
    );
    const workspace = schemaWorkspaceLayer({
      projectRoot: root,
      supabaseDir,
      projectHomeDir,
    }).pipe(Layer.provide(BunServices.layer));
    const layer = Layer.mergeAll(
      mockOutput({ format: "json" }).layer,
      BunServices.layer,
      workspace,
      schemaStateLayer.pipe(Layer.provide(workspace), Layer.provide(BunServices.layer)),
      migrationRepositoryLayer.pipe(Layer.provide(workspace), Layer.provide(BunServices.layer)),
    );

    return Effect.gen(function* () {
      const exit = yield* newMigration("should_fail").pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});
