import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer } from "effect";
import { SchemaMigrationNameError } from "../../shared/schema/schema-errors.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { schemaWorkspaceLayer } from "../../shared/schema/schema-workspace.layer.ts";
import { MigrationRepository } from "../../shared/migrations/migration-repository.service.ts";
import { formatFetchedMigrationSql } from "../../shared/migrations/pull-migrations.ts";
import { legacyMigrationRepositoryLayer } from "./legacy-migration-repository.layer.ts";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "fetched-migrations-"));
  const supabaseDir = join(root, "supabase");
  const projectHomeDir = join(root, ".supabase");
  return { root, supabaseDir, projectHomeDir };
}

describe("legacyMigrationRepositoryLayer writeFetched", () => {
  it.live("writes, skips identical SQL, and side-files a mismatch", () => {
    const project = tempProject();
    const out = mockOutput({ interactive: false });
    const workspace = schemaWorkspaceLayer({
      projectRoot: project.root,
      supabaseDir: project.supabaseDir,
      projectHomeDir: project.projectHomeDir,
    }).pipe(Layer.provide(BunServices.layer));
    const layer = Layer.mergeAll(
      out.layer,
      workspace,
      legacyMigrationRepositoryLayer.pipe(
        Layer.provide(workspace),
        Layer.provide(BunServices.layer),
        Layer.provide(out.layer),
      ),
    );
    return Effect.gen(function* () {
      const repository = yield* MigrationRepository;
      const sql = formatFetchedMigrationSql(["create table t (id int)"]);
      const written = yield* repository.writeFetched({
        version: "20260101000000",
        name: "init",
        sql,
      });
      expect(written.outcome).toBe("written");
      expect(
        readFileSync(join(project.supabaseDir, "migrations", "20260101000000_init.sql"), "utf8"),
      ).toBe(sql);

      const skipped = yield* repository.writeFetched({
        version: "20260101000000",
        name: "init",
        sql,
      });
      expect(skipped.outcome).toBe("skipped");

      writeFileSync(
        join(project.supabaseDir, "migrations", "20260101000000_init.sql"),
        "select 1;\n",
      );
      const conflict = yield* repository.writeFetched({
        version: "20260101000000",
        name: "init",
        sql,
      });
      expect(conflict.outcome).toBe("conflict");
      if (conflict.outcome === "conflict") {
        expect(conflict.remoteCopyDisplay).toBe(
          ".supabase/remote-migrations/20260101000000_init.sql",
        );
        expect(readFileSync(conflict.remoteCopyPath, "utf8")).toBe(sql);
        expect(
          readFileSync(join(project.supabaseDir, "migrations", "20260101000000_init.sql"), "utf8"),
        ).toBe("select 1;\n");
      }

      const escape = yield* repository
        .writeFetched({ version: "../oops", name: "x", sql })
        .pipe(Effect.exit);
      expect(Exit.isFailure(escape)).toBe(true);
      const failure = Exit.isFailure(escape) ? Cause.findErrorOption(escape.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaMigrationNameError);
      }
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(project.root, { recursive: true, force: true }))),
    );
  });

  it.live("skips a same-version file that was renamed locally", () => {
    const project = tempProject();
    const out = mockOutput({ interactive: false });
    const workspace = schemaWorkspaceLayer({
      projectRoot: project.root,
      supabaseDir: project.supabaseDir,
      projectHomeDir: project.projectHomeDir,
    }).pipe(Layer.provide(BunServices.layer));
    const layer = Layer.mergeAll(
      out.layer,
      workspace,
      legacyMigrationRepositoryLayer.pipe(
        Layer.provide(workspace),
        Layer.provide(BunServices.layer),
        Layer.provide(out.layer),
      ),
    );
    const sql = formatFetchedMigrationSql(["create table t (id int)"]);
    mkdirSync(join(project.supabaseDir, "migrations"), { recursive: true });
    writeFileSync(join(project.supabaseDir, "migrations", "20260101000000_initial.sql"), sql);
    return Effect.gen(function* () {
      const repository = yield* MigrationRepository;
      const skipped = yield* repository.writeFetched({
        version: "20260101000000",
        name: "init",
        sql,
      });
      expect(skipped.outcome).toBe("skipped");
      if (skipped.outcome === "skipped") {
        expect(skipped.file.fileName).toBe("20260101000000_initial.sql");
      }
      expect(readdirSync(join(project.supabaseDir, "migrations"))).toEqual([
        "20260101000000_initial.sql",
      ]);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(project.root, { recursive: true, force: true }))),
    );
  });
});
