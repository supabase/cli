import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import type { Pool } from "pg";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { pullSchema } from "./pull-schema.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";
import { schemaStateLayer } from "./schema-state.layer.ts";
import { schemaWorkspaceLayer } from "./schema-workspace.layer.ts";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "schema-pull-"));
  const supabaseDir = join(root, "supabase");
  const projectHomeDir = join(root, ".supabase");
  mkdirSync(supabaseDir, { recursive: true });
  mkdirSync(projectHomeDir, { recursive: true });
  return { root, supabaseDir, projectHomeDir };
}

function mockEngine(files: Array<{ name: string; sql: string }>) {
  return Layer.succeed(
    PgDeltaSchemaEngine,
    PgDeltaSchemaEngine.of({
      exportSchema: (_pool: Pool) =>
        Effect.succeed({
          files,
          manifest: {
            redactSecrets: true,
            profile: "supabase",
            scope: "database",
            files: files.map((f) => f.name),
          },
          snapshot: '{"catalog":true}',
          engineVersion: "0.3.0",
        }),
      planFiles: () => Effect.die("unused"),
      diffPools: () => Effect.die("unused"),
      applyPlan: () => Effect.die("unused"),
      provisionShadow: Effect.die("unused"),
    }),
  );
}

function mockTarget() {
  return Layer.succeed(
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
  );
}

function mockMigrations() {
  return Layer.succeed(
    MigrationRepository,
    MigrationRepository.of({
      listLocal: Effect.succeed([]),
      createEmpty: () => Effect.die("unused"),
      writeGenerated: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
    }),
  );
}

function setup(files = [{ name: "public.sql", sql: "create table public.t (id int);\n" }]) {
  const project = tempProject();
  const out = mockOutput({ format: "json", interactive: false });
  const workspace = schemaWorkspaceLayer({
    projectRoot: project.root,
    supabaseDir: project.supabaseDir,
    projectHomeDir: project.projectHomeDir,
  }).pipe(Layer.provide(BunServices.layer));
  const layer = Layer.mergeAll(
    out.layer,
    BunServices.layer,
    workspace,
    schemaStateLayer.pipe(Layer.provide(workspace), Layer.provide(BunServices.layer)),
    mockEngine(files),
    mockTarget(),
    mockMigrations(),
  );
  return { project, layer };
}

describe("pullSchema", () => {
  it.live("writes declarations and the export manifest into an empty tree", () => {
    const { project, layer } = setup();
    return Effect.gen(function* () {
      const result = yield* pullSchema({ from: "local", force: false, pruneUnmanaged: false }).pipe(
        Effect.provide(layer),
      );
      expect(result.mutatedFiles).toBe(true);
      expect(result.data["created"]).toEqual(["public.sql"]);
      expect(existsSync(join(project.supabaseDir, "schemas", "public.sql"))).toBe(true);
      expect(existsSync(join(project.supabaseDir, "schemas", ".schema-checkpoint.json"))).toBe(
        false,
      );
      expect(existsSync(join(project.supabaseDir, "schemas", ".pgdelta-export.json"))).toBe(true);
    });
  });

  it.live("fails closed when declarations already exist", () => {
    const { project, layer } = setup();
    mkdirSync(join(project.supabaseDir, "schemas"), { recursive: true });
    writeFileSync(join(project.supabaseDir, "schemas", "existing.sql"), "select 1;\n");
    return Effect.gen(function* () {
      const exit = yield* pullSchema({ from: "local", force: false, pruneUnmanaged: false }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("does not touch _custom when replacing", () => {
    const { project, layer } = setup();
    const custom = join(project.supabaseDir, "schemas", "_custom");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "hand.sql"), "create cast (int as text);\n");
    return Effect.gen(function* () {
      yield* pullSchema({ from: "local", force: true, pruneUnmanaged: false }).pipe(
        Effect.provide(layer),
      );
      expect(readFileSync(join(custom, "hand.sql"), "utf8")).toBe("create cast (int as text);\n");
    });
  });

  it.live("fails closed on unmanaged files unless --prune-unmanaged", () => {
    const { project, layer } = setup([{ name: "kept.sql", sql: "select 1;\n" }]);
    const schemas = join(project.supabaseDir, "schemas");
    mkdirSync(schemas, { recursive: true });
    writeFileSync(join(schemas, "kept.sql"), "select 1;\n");
    writeFileSync(join(schemas, "stray.sql"), "select 2;\n");
    writeFileSync(
      join(schemas, ".pgdelta-export.json"),
      `${JSON.stringify({ formatVersion: 1, files: ["kept.sql"] }, null, 2)}\n`,
    );
    return Effect.gen(function* () {
      const exit = yield* pullSchema({ from: "local", force: true, pruneUnmanaged: false }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("prunes unmanaged files when --prune-unmanaged is passed", () => {
    const { project, layer } = setup([{ name: "kept.sql", sql: "select 1;\n" }]);
    const schemas = join(project.supabaseDir, "schemas");
    mkdirSync(schemas, { recursive: true });
    writeFileSync(join(schemas, "kept.sql"), "select 1;\n");
    writeFileSync(join(schemas, "stray.sql"), "select 2;\n");
    writeFileSync(
      join(schemas, ".pgdelta-export.json"),
      `${JSON.stringify({ formatVersion: 1, files: ["kept.sql"] }, null, 2)}\n`,
    );
    return Effect.gen(function* () {
      yield* pullSchema({ from: "local", force: true, pruneUnmanaged: true }).pipe(
        Effect.provide(layer),
      );
      expect(existsSync(join(schemas, "kept.sql"))).toBe(true);
      expect(existsSync(join(schemas, "stray.sql"))).toBe(false);
    });
  });

  it.live("refuses a primary-tree pull while a draft is ahead, without writing files", () => {
    const { project, layer } = setup();
    const schemas = join(project.supabaseDir, "schemas");
    mkdirSync(schemas, { recursive: true });
    writeFileSync(join(schemas, "existing.sql"), "select 1;\n");
    writeFileSync(
      join(project.projectHomeDir, "schema-draft.json"),
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
    return Effect.gen(function* () {
      const exit = yield* pullSchema({ from: "local", force: true, pruneUnmanaged: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(readFileSync(join(schemas, "existing.sql"), "utf8")).toBe("select 1;\n");
      expect(existsSync(join(schemas, "public.sql"))).toBe(false);
    });
  });
});
