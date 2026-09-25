import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path, Predicate, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
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

const storageMarker = Schema.Struct({
  backend: Schema.Literals(["docker", "host"]),
  volume: Schema.optionalKey(Schema.String),
});

class DockerCleanupError extends Data.TaggedError("DockerCleanupError")<{
  readonly message: string;
}> {}

const removeDockerVolume = Effect.fn("DbDiffStackCacheE2e.removeDockerVolume")((volume: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", ["volume", "rm", volume], { stdin: "ignore" }),
      );
      const [stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.runDrain),
          child.stderr.pipe(Stream.decodeText, Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([, stderr, code]) => [stderr, code] as const));
      if (Number(code) !== 0 && !/no such volume/iu.test(stderr))
        return yield* new DockerCleanupError({
          message: `docker volume rm ${volume} failed: ${stderr.trim() || `exit ${code}`}`,
        });
    }),
  ),
);

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
  let databaseId: string | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const marker = yield* Effect.gen(function* () {
        if (runtime !== "docker" || databaseId === undefined) return undefined;
        const fs = yield* FileSystem.FileSystem;
        const markerText = yield* fs
          .readFileString(
            `${home}/stacks/${stack.id}/data/${databaseId}/.supabase-database-storage.json`,
          )
          .pipe(
            Effect.catchIf(
              (cause) => Predicate.isTagged(cause.reason, "NotFound"),
              () => Effect.void,
            ),
          );
        if (markerText === undefined) return undefined;
        return yield* Schema.decodeEffect(Schema.fromJsonString(storageMarker))(markerText);
      }).pipe(Effect.exit);
      const destroyed = yield* stack.destroy.pipe(Effect.exit);
      const volume =
        Exit.isSuccess(marker) && marker.value !== undefined && marker.value.backend === "docker"
          ? marker.value.volume
          : undefined;
      const removed =
        volume === undefined
          ? Exit.succeed(undefined)
          : yield* removeDockerVolume(volume).pipe(Effect.exit);
      if (Exit.isFailure(destroyed)) return yield* Effect.failCause(destroyed.cause);
      if (Exit.isFailure(marker)) return yield* Effect.failCause(marker.cause);
      if (Exit.isFailure(removed)) return yield* Effect.failCause(removed.cause);
    }).pipe(Effect.catchCause((cause) => Effect.die(cause))),
  );
  const [database] = yield* stack.composition.supabase([
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
  if (database === undefined) return yield* Effect.die("database composition missing");
  databaseId = database.id;
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
          expect(second.stderr).not.toMatch(/baseline (?:unusable|not cached)/iu);
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
