// Starts a native stack through the compiled CLI binary, checks its status and connection-variable
// export, then stops and destroys that stack through the CLI.
import { BunServices } from "@effect/platform-bun";
import {
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
  Predicate,
  Schema,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { parse as parseDotenv } from "dotenv";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import {
  makeTempHome,
  runSupabaseEffect,
  spawnSupabase,
} from "../../../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const hostRuntime = ManagedRuntime.make(Layer.mergeAll(BunServices.layer));
afterAll(() => hostRuntime.dispose());

const { join, dirname, basename } = hostRuntime.runSync(Path.Path);

const runNode = <A, E>(
  program: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
) => hostRuntime.runPromise(program);

class StartE2eProcessError extends Data.TaggedError("StartE2eProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const withFs = <A, E>(operation: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) =>
  Effect.flatMap(FileSystem.FileSystem, operation);

const access = (filePath: string) => withFs((fs) => fs.access(filePath));

const makeDirectory = (directory: string, options?: { readonly recursive?: boolean }) =>
  withFs((fs) => fs.makeDirectory(directory, options));

const readDirectory = (directory: string) => withFs((fs) => fs.readDirectory(directory));

const realPath = (filePath: string) => withFs((fs) => fs.realPath(filePath));

const remove = (
  filePath: string,
  options: { readonly recursive: boolean; readonly force: boolean },
) => withFs((fs) => fs.remove(filePath, options));

const writeText = (filePath: string, contents: string) =>
  withFs((fs) => fs.writeFileString(filePath, contents));

const makeTempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({ directory: dirname(prefix), prefix: basename(prefix) });
  });

const StackInspectionSchema = Schema.Struct({
  identity: Schema.Struct({ project_root: Schema.String }),
  runtime: Schema.String,
  owner: Schema.Literals(["reachable", "unavailable"]),
  lifecycle: Schema.NullOr(Schema.String),
  composition: Schema.Struct({
    members: Schema.Array(
      Schema.Struct({ id: Schema.String, service: Schema.String, state: Schema.String }),
    ),
  }),
  endpoints: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String })),
});

const FollowEventSchema = Schema.Struct({
  type: Schema.String,
  service: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
});

const VariablesSchema = Schema.Record(Schema.String, Schema.String);
const StartResultSchema = Schema.Struct({ id: Schema.String });

const minimalConfig = `project_id = "compiled-stack-start-e2e"

[experimental]
stack = true

[api]
enabled = true

[auth]
enabled = false

[db.pooler]
enabled = false

[edge_runtime]
enabled = false

[realtime]
enabled = false

[storage]
enabled = false

[studio]
enabled = false

[analytics]
enabled = false

[local_smtp]
enabled = false
`;

const inspectStackState = (home: string, stackId: string) => {
  return Effect.gen(function* () {
    const result = yield* runSupabaseEffect(
      ["stack", "status", "--stack-id", stackId, "--output-format", "json"],
      {
        home,
        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
        exitTimeoutMs: CLEANUP_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0) {
      return yield* new StartE2eProcessError({
        message: `Stack status returned ${result.exitCode}:\n${result.stderr}`,
      });
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(StackInspectionSchema))(
      result.stdout.trim(),
    );
  });
};

const destroyStack = (home: string, stackId: string) =>
  Effect.flatMap(
    runSupabaseEffect(["stack", "destroy", "--stack-id", stackId, "--yes"], {
      home,
      env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
      exitTimeoutMs: CLEANUP_TIMEOUT_MS,
    }),
    (result) =>
      result.exitCode === 0
        ? Effect.void
        : new StartE2eProcessError({
            message: `stack destroy exited ${result.exitCode}: ${result.stderr}`,
          }),
  );

const waitForOutput = (
  spawned: ReturnType<typeof spawnSupabase>,
  pattern: RegExp,
  timeoutMs: number,
) =>
  Effect.tryPromise({
    try: () => spawned.waitForOutput(pattern, timeoutMs),
    catch: (cause) =>
      new StartE2eProcessError({
        message: "stack logs follower did not produce live output",
        cause,
      }),
  });

describe("stack start (compiled e2e)", () => {
  let home: ReturnType<typeof makeTempHome> | undefined;
  let projectDir: string | undefined;
  let stackId: string | undefined;
  let stackDestroyed = false;

  const cleanup = Effect.gen(function* () {
    let cleanupComplete = stackDestroyed;
    if (!cleanupComplete && home !== undefined) {
      const candidates = yield* readDirectory(join(home.dir, "stacks")).pipe(
        Effect.catchIf(
          (cause) =>
            Predicate.isTagged(cause, "PlatformError") &&
            Predicate.isTagged(cause.reason, "NotFound"),
          () => Effect.succeed([]),
        ),
      );
      const discovered = candidates.filter((entry) => /^[0-9a-f]{64}$/u.test(entry));
      const ownedId = stackId ?? (discovered.length === 1 ? discovered[0] : undefined);
      if (ownedId !== undefined) {
        yield* destroyStack(home.dir, ownedId);
        cleanupComplete = true;
      } else if (discovered.length > 1) {
        return yield* new StartE2eProcessError({
          message: `Could not identify one owned stack for cleanup: ${discovered.join(", ")}`,
        });
      } else {
        cleanupComplete = true;
      }
    }
    if (!cleanupComplete) return;
    if (projectDir !== undefined) {
      yield* remove(projectDir, { recursive: true, force: true });
    }
    yield* Effect.try({
      try: () => home?.[Symbol.dispose](),
      catch: (cause) =>
        new StartE2eProcessError({ message: "Failed to dispose temporary CLI home", cause }),
    });
    home = undefined;
    projectDir = undefined;
    stackId = undefined;
    stackDestroyed = false;
  });

  afterEach(() => runNode(cleanup), CLEANUP_TIMEOUT_MS);

  test.skipIf(!nativeSupported)(
    "starts and stops a native stack while preserving its database",
    { timeout: START_TIMEOUT_MS + CLEANUP_TIMEOUT_MS },
    () =>
      runNode(
        Effect.gen(function* () {
          home = makeTempHome();
          projectDir = yield* makeTempDirectory("/tmp/supabase-compiled-stack-start-e2e-");
          yield* makeDirectory(join(projectDir, "supabase"), { recursive: true });
          yield* writeText(join(projectDir, "supabase", "config.toml"), minimalConfig);

          const excluded = yield* runSupabaseEffect(
            ["stack", "start", "--runtime", "native", "--exclude", "rest", "--eager"],
            { cwd: projectDir, home: home.dir, exitTimeoutMs: START_TIMEOUT_MS },
          );
          expect(
            excluded.exitCode,
            `stdout:\n${excluded.stdout}\nstderr:\n${excluded.stderr}`,
          ).toBe(0);

          const result = yield* runSupabaseEffect(
            ["stack", "start", "--runtime", "native", "--eager", "--output-format", "json"],
            { cwd: projectDir, home: home.dir, exitTimeoutMs: START_TIMEOUT_MS },
          );
          expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
          const startResult = yield* Schema.decodeEffect(Schema.fromJsonString(StartResultSchema))(
            result.stdout.trim(),
          );
          stackId = startResult.id;
          const idText = stackId;
          const homeDir = home;
          const projectRoot = projectDir;
          if (idText === undefined || homeDir === undefined || projectRoot === undefined)
            throw new Error("compiled start did not return a stack id");

          const running = yield* inspectStackState(homeDir.dir, idText);
          expect(running.owner).toBe("reachable");
          expect(running.identity.project_root).toBe(yield* realPath(projectRoot));
          expect(running.runtime).toBe("native");
          expect(running.lifecycle).toBe("running");
          expect(
            running.composition.members.find(({ service }) => service === "database")?.state,
          ).toBe("running");
          expect(running.composition.members.some(({ service }) => service === "rest")).toBe(true);
          expect(running.endpoints["database.sql"]?.url).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
          const databaseId = running.composition.members.find(
            ({ service }) => service === "database",
          )?.id;
          if (databaseId === undefined) return yield* Effect.die("database member id is missing");
          const databasePath = join(homeDir.dir, "stacks", idText, "data", databaseId);
          yield* access(join(databasePath, "data", "PG_VERSION"));

          const followResult = yield* Effect.scoped(
            Effect.gen(function* () {
              const followed = yield* Effect.acquireRelease(
                Effect.try({
                  try: () =>
                    spawnSupabase(
                      [
                        "stack",
                        "logs",
                        "--stack-id",
                        idText,
                        "--service",
                        "database",
                        "--output-format",
                        "stream-json",
                      ],
                      {
                        cwd: projectRoot,
                        home: homeDir.dir,
                        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
                        exitTimeoutMs: CLEANUP_TIMEOUT_MS,
                      },
                    ),
                  catch: (cause) =>
                    new StartE2eProcessError({ message: "failed to spawn logs follower", cause }),
                }),
                (spawned) =>
                  Effect.sync(() => spawned.releaseOwned({ successOptOut: false })).pipe(
                    Effect.flatMap(() => spawned.exitEffect(CLEANUP_TIMEOUT_MS)),
                    Effect.asVoid,
                    Effect.catchTag("CliHomeDisposeError", (cause) =>
                      Effect.die(
                        new StartE2eProcessError({
                          message: "Follower reused the shared CLI home; disposal must not fail",
                          cause,
                        }),
                      ),
                    ),
                  ),
              );
              const restarted = yield* runSupabaseEffect(
                ["stack", "restart", "--stack-id", idText],
                {
                  cwd: projectRoot,
                  home: homeDir.dir,
                  env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
                  exitTimeoutMs: START_TIMEOUT_MS,
                },
              );
              expect(
                restarted.exitCode,
                `stdout:\n${restarted.stdout}\nstderr:\n${restarted.stderr}`,
              ).toBe(0);
              yield* waitForOutput(
                followed,
                /"type":"log-entry".*"source":"live"/u,
                START_TIMEOUT_MS,
              );
              yield* Effect.sync(() => followed.kill("SIGINT"));
              return yield* followed.exitEffect(CLEANUP_TIMEOUT_MS);
            }),
          );
          expect(
            followResult.exitCode,
            `stdout:\n${followResult.stdout}\nstderr:\n${followResult.stderr}`,
          ).toBe(130);
          const followEvents = yield* Effect.forEach(
            followResult.stdout
              .trim()
              .split("\n")
              .filter((line) => line.length > 0),
            (line) => Schema.decodeEffect(Schema.fromJsonString(FollowEventSchema))(line),
          );
          const liveEntries = followEvents.filter(
            (event) => event.type === "log-entry" && event.source === "live",
          );
          expect(liveEntries.length).toBeGreaterThan(0);
          expect(liveEntries.every((event) => event.service === "database")).toBe(true);

          const afterFollow = yield* inspectStackState(homeDir.dir, idText);
          expect(afterFollow.owner).toBe("reachable");
          expect(afterFollow.lifecycle).toBe("running");
          expect(
            afterFollow.composition.members.find(({ service }) => service === "database")?.state,
          ).toBe("running");
          const status = yield* runSupabaseEffect(["stack", "status", "--stack-id", idText], {
            cwd: projectRoot,
            home: homeDir.dir,
            exitTimeoutMs: CLEANUP_TIMEOUT_MS,
          });
          expect(status.exitCode, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`).toBe(0);
          expect(status.stdout).toContain(`(${idText})`);
          expect(status.stdout).toContain("Owner: reachable");
          expect(status.stdout).toContain("Lifecycle: running");
          expect(status.stdout).toContain("Readiness: ready");
          expect(status.stdout).toMatch(/Config drift: (changed|unchanged)/u);

          const topLevelStatus = yield* runSupabaseEffect(["status", "--stack-id", idText], {
            cwd: projectRoot,
            home: homeDir.dir,
            env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
            exitTimeoutMs: CLEANUP_TIMEOUT_MS,
          });
          expect(
            topLevelStatus.exitCode,
            `stdout:\n${topLevelStatus.stdout}\nstderr:\n${topLevelStatus.stderr}`,
          ).toBe(0);
          expect(topLevelStatus.stdout).toContain(`(${idText})`);
          expect(topLevelStatus.stdout).toContain("Owner: reachable");
          expect(topLevelStatus.stdout).toContain("Lifecycle: running");

          const env = yield* runSupabaseEffect(
            ["stack", "status", "--env", "--stack-id", idText, "--output-format", "json"],
            { cwd: projectRoot, home: homeDir.dir, exitTimeoutMs: CLEANUP_TIMEOUT_MS },
          );
          expect(env.exitCode, `stdout:\n${env.stdout}\nstderr:\n${env.stderr}`).toBe(0);
          const variables = yield* Schema.decodeEffect(Schema.fromJsonString(VariablesSchema))(
            env.stdout,
          );
          expect(Object.keys(variables)).toEqual([
            "DB_URL",
            "ANON_KEY",
            "SERVICE_ROLE_KEY",
            "API_URL",
          ]);
          expect(variables.DB_URL).toMatch(
            /^postgresql:\/\/supabase_admin:.+@.+:\d+\/postgres(?:\?.*)?$/u,
          );

          const dotenv = yield* runSupabaseEffect(
            ["stack", "status", "--env", "--stack-id", idText, "--output-format", "text"],
            { cwd: projectRoot, home: homeDir.dir, exitTimeoutMs: CLEANUP_TIMEOUT_MS },
          );
          expect(dotenv.exitCode, `stdout:\n${dotenv.stdout}\nstderr:\n${dotenv.stderr}`).toBe(0);
          expect(parseDotenv(dotenv.stdout)).toEqual(variables);

          yield* remove(join(projectRoot, "supabase", "config.toml"), {
            recursive: false,
            force: false,
          });
          const stop = yield* runSupabaseEffect(["stack", "stop", "--stack-id", idText], {
            cwd: projectRoot,
            home: homeDir.dir,
            env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
            exitTimeoutMs: CLEANUP_TIMEOUT_MS,
          });
          expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);

          const observed = yield* inspectStackState(homeDir.dir, idText);
          expect(observed.owner).toBe("unavailable");
          expect(observed.identity.project_root).toBe(yield* realPath(projectRoot));
          expect(observed.runtime).toBe("native");
          expect(observed.lifecycle).toBeNull();
          expect(
            observed.composition.members.find(({ service }) => service === "database")?.state,
          ).toBe("unavailable");

          const stoppedStatus = yield* runSupabaseEffect(
            ["stack", "status", "--stack-id", idText],
            {
              cwd: projectRoot,
              home: homeDir.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs: CLEANUP_TIMEOUT_MS,
            },
          );
          expect(
            stoppedStatus.exitCode,
            `stdout:\n${stoppedStatus.stdout}\nstderr:\n${stoppedStatus.stderr}`,
          ).toBe(0);
          expect(stoppedStatus.stdout).toContain("Owner: unavailable");
          expect(stoppedStatus.stdout).toContain("Lifecycle: unavailable");
          expect(stoppedStatus.stdout).toContain("Readiness: unavailable");

          const stoppedEnv = yield* runSupabaseEffect(
            ["stack", "status", "--env", "--stack-id", idText],
            {
              cwd: projectRoot,
              home: homeDir.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs: CLEANUP_TIMEOUT_MS,
            },
          );
          expect(stoppedEnv.exitCode).not.toBe(0);
          expect(stoppedEnv.stdout).not.toContain("DB_URL");
          expect(stoppedEnv.stderr).toContain(
            "The stack owner or primary database is unavailable for environment export.",
          );

          yield* access(join(databasePath, "data", "PG_VERSION"));

          const stoppedLogs = yield* runSupabaseEffect(
            [
              "stack",
              "logs",
              "--stack-id",
              idText,
              "--service",
              "database",
              "--output-format",
              "stream-json",
            ],
            {
              cwd: projectRoot,
              home: homeDir.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs: CLEANUP_TIMEOUT_MS,
            },
          );
          expect(stoppedLogs.exitCode).not.toBe(0);
          expect(`${stoppedLogs.stdout}\n${stoppedLogs.stderr}`).toMatch(
            /unavailable|not running|must be running/iu,
          );

          yield* destroyStack(homeDir.dir, idText);
          stackDestroyed = true;

          const destroyed = yield* Effect.exit(access(join(homeDir.dir, "stacks", idText)));
          expect(Exit.isFailure(destroyed)).toBe(true);
        }),
      ),
  );
});
