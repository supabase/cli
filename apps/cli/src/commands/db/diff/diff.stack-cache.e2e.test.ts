import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { create as createStack } from "@supabase/stack/effect";
import { tmpdir } from "node:os";
import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const COMMAND_TIMEOUT_MS = 8 * 60_000;
const TEST_TIMEOUT_MS = COMMAND_TIMEOUT_MS * 4 + 2 * 60_000;
const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const config = `project_id = "db-diff-stack-cache-e2e"

[experimental]
stack = true

[db]
major_version = 17

[auth]
enabled = false

[storage]
enabled = false

[realtime]
enabled = false
`;

const composeStack = Effect.fn("DbDiffStackCacheE2e.composeStack")(function* (
  root: string,
  home: string,
  runtime: "native" | "docker",
) {
  const stack = yield* createStack({
    projectRoot: root,
    stateRoot: `${home}/stacks`,
    cacheRoot: `${home}/cache/stack`,
    runtime,
  });
  yield* Effect.addFinalizer(() =>
    stack.destroy.pipe(
      Effect.catch((cause) => Effect.die(new Error(`stack cleanup failed: ${cause.message}`))),
    ),
  );
  yield* stack.composition.supabase([
    {
      service: "database",
      config: {
        version: "17",
        databasePassword: Redacted.make("postgres"),
        jwtSecret: Redacted.make("db-diff-stack-cache-e2e-jwt-secret-with-32-chars"),
        jwtExpiry: 3600,
      },
      endpoints: { sql: { port: "auto" } },
    },
  ]);
  yield* stack.composition.start;
  return stack;
});

const command = (args: ReadonlyArray<string>, cwd: string, home: string) =>
  runSupabaseEffect([...args], {
    cwd,
    home,
    env: { SUPABASE_EXPERIMENTAL_STACK: "1", SUPABASE_SHADOW_CACHE: undefined },
    exitTimeoutMs: COMMAND_TIMEOUT_MS,
  });

const assertSuccess = (
  result: { exitCode: number; stdout: string; stderr: string },
  name: string,
) => {
  expect(result.exitCode, `${name}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
};

describe("supabase db diff (stack shadow baseline cache)", () => {
  for (const runtime of ["native", "docker"] as const) {
    if (runtime === "native" && !nativeSupported) continue;

    it.live(
      `reuses a ${runtime} baseline while replaying changed project migrations`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* fs.makeTempDirectoryScoped({
            prefix: `db-diff-cache-${runtime}-`,
          });
          const home = yield* fs.makeTempDirectoryScoped({
            prefix: `db-diff-cache-home-${runtime}-`,
          });
          const sharedArtifacts = path.join(tmpdir(), "supabase-stack-artifacts");
          yield* fs.makeDirectory(sharedArtifacts, { recursive: true });
          yield* fs.makeDirectory(path.join(home, "cache"), { recursive: true });
          yield* fs.symlink(sharedArtifacts, path.join(home, "cache", "stack"));

          const supabase = path.join(project, "supabase");
          const migrations = path.join(supabase, "migrations");
          yield* fs.makeDirectory(migrations, { recursive: true });
          yield* fs.writeFileString(path.join(supabase, "config.toml"), config);
          const migrationPath = path.join(migrations, "20260921000000_cache_story.sql");
          yield* fs.writeFileString(
            migrationPath,
            "create table public.stack_cache_first (value text primary key);\n",
          );

          const stack = yield* composeStack(project, home, runtime);

          const first = yield* command(
            ["db", "diff", "--from", "migrations", "--to", "local", "--use-pg-delta"],
            project,
            home,
          );
          assertSuccess(first, `${runtime} cold db diff`);
          expect(first.stdout).toMatch(/stack_cache_first/iu);

          yield* fs.writeFileString(
            migrationPath,
            "create table public.stack_cache_second (value text primary key);\n",
          );
          const second = yield* command(
            ["db", "diff", "--from", "migrations", "--to", "local", "--use-pg-delta"],
            project,
            home,
          );
          assertSuccess(second, `${runtime} warm db diff`);
          expect(second.stdout).toMatch(/stack_cache_second/iu);
          expect(second.stdout).not.toMatch(/stack_cache_first/iu);

          const stackEntries = (yield* fs.readDirectory(path.join(home, "stacks"))).filter(
            (entry) => /^[0-9a-f]{64}$/u.test(entry),
          );
          expect(stackEntries).toEqual([stack.id]);
        }).pipe(Effect.scoped, Effect.provide([BunServices.layer, FetchHttpClient.layer])),
      { timeout: TEST_TIMEOUT_MS },
    );
  }
});
