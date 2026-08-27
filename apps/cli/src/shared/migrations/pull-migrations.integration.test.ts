import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { DatabaseTarget } from "../database/database-target.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { SchemaEmptyMigrationStatementsError } from "../schema/schema-errors.ts";
import type { MigrationFile } from "./migration-file.ts";
import { formatFetchedMigrationSql, pullMigrations } from "./pull-migrations.ts";
import { MigrationRepository, type FetchedMigrationWrite } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

const linkedTarget = {
  kind: "linked" as const,
  identity: "abcdefghijklmnop",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: true,
  projectRef: "abcdefghijklmnop",
} satisfies DatabaseTarget;

const urlTarget = {
  kind: "url" as const,
  identity: "connection-string",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: false,
} satisfies DatabaseTarget;

const pendingFile = {
  version: "20260201000000",
  name: "billing",
  fileName: "20260201000000_billing.sql",
  absolutePath: "/tmp/migrations/20260201000000_billing.sql",
  content: "select 2;",
  transactional: true,
} satisfies MigrationFile;

const initFile = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: formatFetchedMigrationSql(["create table t (id int)"]),
  transactional: true,
} satisfies MigrationFile;

function setup(
  opts: {
    remote?: ReadonlyArray<{
      version: string;
      name: string;
      statements: ReadonlyArray<string>;
    }>;
    local?: ReadonlyArray<MigrationFile>;
    target?: DatabaseTarget;
  } = {},
) {
  const out = mockOutput({ interactive: false });
  const local = [...(opts.local ?? [])];
  const writes: Array<FetchedMigrationWrite> = [];
  return {
    writes,
    layer: Layer.mergeAll(
      out.layer,
      Layer.succeed(
        DatabaseTargetResolver,
        DatabaseTargetResolver.of({
          resolve: () => Effect.succeed(opts.target ?? linkedTarget),
        }),
      ),
      Layer.succeed(
        MigrationRepository,
        MigrationRepository.of({
          listLocal: Effect.sync(() => local),
          createEmpty: () => Effect.die("unused"),
          writeFetched: (input) =>
            Effect.sync(() => {
              const existing = local.find((file) => file.version === input.version);
              const file: MigrationFile = {
                version: input.version,
                name: input.name,
                fileName: `${input.version}_${input.name}.sql`,
                absolutePath: `/tmp/migrations/${input.version}_${input.name}.sql`,
                content: existing?.content ?? input.sql,
                transactional: true,
              };
              if (existing === undefined) {
                local.push({ ...file, content: input.sql });
                const written = {
                  outcome: "written" as const,
                  file: { ...file, content: input.sql },
                };
                writes.push(written);
                return written;
              }
              if (existing.content === input.sql) {
                const skipped = { outcome: "skipped" as const, file: existing };
                writes.push(skipped);
                return skipped;
              }
              const conflict = {
                outcome: "conflict" as const,
                file: existing,
                remoteCopyPath: `/tmp/.supabase/remote-migrations/${file.fileName}`,
                remoteCopyDisplay: `.supabase/remote-migrations/${file.fileName}`,
              };
              writes.push(conflict);
              return conflict;
            }),
          writeGenerated: () => Effect.die("provisionMigrations/writeGenerated must not run"),
          remove: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        MigrationRunner,
        MigrationRunner.of({
          listRemote: () => Effect.die("unused"),
          listRemoteStatements: () => Effect.succeed(opts.remote ?? []),
          showServerVersion: () => Effect.succeed(undefined),
          listInstalledExtensions: () => Effect.die("unused"),
          applyPending: () => Effect.die("unused"),
          markApplied: () => Effect.die("unused"),
        }),
      ),
    ),
  };
}

describe("pullMigrations", () => {
  it.live("writes nothing when remote history is empty", () => {
    const ctx = setup({ remote: [], local: [initFile] });
    return Effect.gen(function* () {
      const result = yield* pullMigrations({}).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedFiles).toBe(false);
      expect(result.message).toBe("Nothing to fetch.");
      expect(result.data).toEqual(expect.objectContaining({ files: [] }));
      expect(ctx.writes).toEqual([]);
    });
  });

  it.live("writes a missing file at the remote version", () => {
    const ctx = setup({
      remote: [
        { version: "20260101000000", name: "init", statements: ["create table t (id int)"] },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* pullMigrations({}).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedFiles).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({
          files: [
            { name: "20260101000000_init.sql", version: "20260101000000", status: "fetched" },
          ],
        }),
      );
      expect(ctx.writes).toEqual([
        expect.objectContaining({
          outcome: "written",
          file: expect.objectContaining({
            version: "20260101000000",
            name: "init",
            fileName: "20260101000000_init.sql",
          }),
        }),
      ]);
    });
  });

  it.live("skips an identical local file", () => {
    const ctx = setup({
      local: [initFile],
      remote: [
        { version: initFile.version, name: initFile.name, statements: ["create table t (id int)"] },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* pullMigrations({}).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedFiles).toBe(false);
      expect(ctx.writes[0]?.outcome).toBe("skipped");
    });
  });

  it.live("writes a side file when SQL differs", () => {
    const ctx = setup({
      local: [initFile],
      remote: [
        {
          version: initFile.version,
          name: initFile.name,
          statements: ["create table t (id int, n int)"],
        },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* pullMigrations({}).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedFiles).toBe(true);
      expect(ctx.writes[0]).toEqual(
        expect.objectContaining({
          outcome: "conflict",
          remoteCopyDisplay: ".supabase/remote-migrations/20260101000000_init.sql",
        }),
      );
      expect(result.message).toContain("statements[] join can differ in formatting");
    });
  });

  it.live("keeps empty-statements recovery on the selected URL", () => {
    const ctx = setup({
      target: urlTarget,
      remote: [{ version: "20260101000000", name: "init", statements: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* pullMigrations({
        from: "postgresql://postgres:secret@db.example/postgres",
      }).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value.suggestion).toContain("migrations diff --against <same-url>");
        expect(failure.value.suggestion).toContain(
          "migration repair --db-url <same-url> --status applied 20260101000000",
        );
      }
    });
  });

  it.live("fails named when statements are empty", () => {
    const ctx = setup({
      remote: [{ version: "20260101000000", name: "init", statements: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* pullMigrations({}).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      expect(failure?._tag).toBe("Some");
      if (failure?._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SchemaEmptyMigrationStatementsError);
        expect(failure.value.suggestion).toContain("migrations diff --against linked");
        expect(failure.value.suggestion).toContain(
          "migration repair --project-ref abcdefghijklmnop --status applied 20260101000000",
        );
      }
      expect(ctx.writes).toEqual([]);
    });
  });

  it.live("skips an existing local file when remote statements are empty", () => {
    const ctx = setup({
      local: [initFile],
      remote: [
        { version: initFile.version, name: initFile.name, statements: [] },
        { version: "20260102000000", name: "users", statements: ["create table u (id int)"] },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* pullMigrations({}).pipe(Effect.provide(ctx.layer));
      expect(result.mutatedFiles).toBe(true);
      expect(ctx.writes.map((write) => write.outcome)).toEqual(["written"]);
      expect(result.data).toEqual(
        expect.objectContaining({
          skipped: [initFile.fileName],
          fetched: ["20260102000000_users.sql"],
        }),
      );
    });
  });

  it.live("fails empty remote-only statements before writing earlier rows", () => {
    const ctx = setup({
      remote: [
        { version: "20260101000000", name: "init", statements: ["create table t (id int)"] },
        { version: "20260102000000", name: "legacy", statements: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* pullMigrations({}).pipe(Effect.provide(ctx.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ctx.writes).toEqual([]);
    });
  });

  it.live("points leftover pending files at the selected URL", () => {
    const ctx = setup({
      target: urlTarget,
      local: [pendingFile],
      remote: [
        { version: "20260101000000", name: "init", statements: ["create table t (id int)"] },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* pullMigrations({
        from: "postgresql://postgres:secret@db.example/postgres",
      }).pipe(Effect.provide(ctx.layer));
      expect(result.nextActions).toEqual([
        "to deploy your pending files: supabase migrations push --db-url <same-url> --allow-remote",
      ]);
    });
  });
});
