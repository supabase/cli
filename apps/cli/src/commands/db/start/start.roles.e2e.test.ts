import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { tmpdir } from "node:os";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const COMMAND_TIMEOUT_MS = 8 * 60_000;
const AUX_TIMEOUT_MS = 3 * 60_000;
const TEST_TIMEOUT_MS = COMMAND_TIMEOUT_MS + AUX_TIMEOUT_MS * 5 + 2 * 60_000;

describe("supabase db start (e2e, role alignment)", () => {
  it.live(
    "keeps CLI migration and shadow consumers on postgres",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-db-start-roles-" });
          const home = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-db-start-roles-home-",
          });
          const configPath = path.join(root, "supabase", "config.toml");
          const migrations = path.join(root, "supabase", "migrations");
          yield* fs.makeDirectory(migrations, { recursive: true });
          yield* fs.makeDirectory(path.join(home, "cache"), { recursive: true });
          const artifacts = path.join(tmpdir(), "supabase-stack-artifacts");
          yield* fs.makeDirectory(artifacts, { recursive: true });
          yield* fs.symlink(artifacts, path.join(home, "cache", "stack"));
          yield* fs.writeFileString(
            configPath,
            `project_id = "db-start-roles-e2e"

[experimental]
stack = true
[experimental.pgdelta]
enabled = true
[db]
major_version = 17
[api]
enabled = false
[auth]
enabled = false
[realtime]
enabled = false
[storage]
enabled = false
[edge_runtime]
enabled = false
[studio]
enabled = false
[analytics]
enabled = false
[db.pooler]
enabled = false
[local_smtp]
enabled = false
`,
          );
          yield* fs.writeFileString(
            path.join(migrations, "20260920000000_role_story.sql"),
            "create table public.role_story (id integer primary key);\n",
          );
          yield* Effect.addFinalizer(() =>
            runSupabaseEffect(["stack", "destroy", "--yes"], {
              cwd: root,
              home,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs: AUX_TIMEOUT_MS,
            }).pipe(
              Effect.flatMap((result) =>
                result.exitCode === 0
                  ? Effect.void
                  : Effect.die(`stack cleanup failed: ${result.stderr}`),
              ),
              Effect.catch((error) => Effect.die(`stack cleanup failed: ${String(error)}`)),
            ),
          );

          const started = yield* runSupabaseEffect(["db", "start"], {
            cwd: root,
            home,
            cleanupProcessGroupOnClose: false,
            exitTimeoutMs: COMMAND_TIMEOUT_MS,
          });
          expect(started.exitCode, `${started.stdout}\n${started.stderr}`).toBe(0);

          const types = yield* runSupabaseEffect(["gen", "types", "--local"], {
            cwd: root,
            home,
            exitTimeoutMs: AUX_TIMEOUT_MS,
          });
          expect(types.exitCode, types.stderr).toBe(0);
          expect(types.stdout).toContain("role_story");

          const migra = yield* runSupabaseEffect(["db", "diff", "--local", "--use-migra"], {
            cwd: root,
            home,
            exitTimeoutMs: AUX_TIMEOUT_MS,
          });
          expect(migra.exitCode, migra.stderr).not.toBe(0);
          expect(`${migra.stdout}${migra.stderr}`).toContain("pg-delta engine");

          const historyOwner = yield* runSupabaseEffect(
            [
              "db",
              "query",
              "select tableowner from pg_tables where schemaname = 'supabase_migrations' and tablename = 'schema_migrations'",
              "--local",
              "--output",
              "json",
            ],
            { cwd: root, home, exitTimeoutMs: AUX_TIMEOUT_MS },
          );
          expect(historyOwner.exitCode, historyOwner.stderr).toBe(0);
          expect(JSON.parse(historyOwner.stdout)).toEqual([{ tableowner: "postgres" }]);

          const alter = yield* runSupabaseEffect(
            ["db", "query", "alter table public.role_story add column note text", "--local"],
            { cwd: root, home, exitTimeoutMs: AUX_TIMEOUT_MS },
          );
          expect(alter.exitCode, alter.stderr).toBe(0);

          const insert = yield* runSupabaseEffect(
            ["db", "query", "insert into public.role_story values (1, 'kept')", "--local"],
            { cwd: root, home, exitTimeoutMs: AUX_TIMEOUT_MS },
          );
          expect(insert.exitCode, insert.stderr).toBe(0);

          const diff = yield* runSupabaseEffect(["db", "diff", "--local", "--use-pg-delta"], {
            cwd: root,
            home,
            exitTimeoutMs: AUX_TIMEOUT_MS,
          });
          expect(diff.exitCode, `${diff.stdout}\n${diff.stderr}`).toBe(0);
          expect(diff.stdout).toMatch(/ALTER TABLE[\s\S]*role_story[\s\S]*ADD COLUMN[\s\S]*note/i);
          expect(diff.stdout).not.toMatch(/CREATE TABLE[\s\S]*role_story/i);

          const localRow = yield* runSupabaseEffect(
            [
              "db",
              "query",
              "select id, note from public.role_story",
              "--local",
              "--output",
              "json",
            ],
            { cwd: root, home, exitTimeoutMs: AUX_TIMEOUT_MS },
          );
          expect(localRow.exitCode, localRow.stderr).toBe(0);
          expect(JSON.parse(localRow.stdout)).toEqual([{ id: 1, note: "kept" }]);

          const generate = yield* runSupabaseEffect(
            [
              "db",
              "schema",
              "declarative",
              "generate",
              "--local",
              "--schema",
              "public",
              "--overwrite",
            ],
            { cwd: root, home, exitTimeoutMs: AUX_TIMEOUT_MS },
          );
          expect(generate.exitCode, generate.stderr).toBe(0);

          const sync = yield* runSupabaseEffect(
            ["db", "schema", "declarative", "sync", "--no-apply"],
            { cwd: root, home, exitTimeoutMs: AUX_TIMEOUT_MS },
          );
          expect(sync.exitCode, sync.stderr).toBe(0);
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    { timeout: TEST_TIMEOUT_MS },
  );
});
