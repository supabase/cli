// Starts a native stack through the compiled CLI binary, checks its status and connection-variable
// export, stops it, checks status again, then uses the package's public Promise API to inspect and
// destroy that stack.
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
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
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

const execFileEffect = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly timeout?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd: options.cwd,
        env: options.env,
        extendEnv: options.env !== undefined,
        stdin: "ignore",
        detached: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.map((chunks) => chunks.join("")),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.map((chunks) => chunks.join("")),
        ),
        child.exitCode,
      ],
      { concurrency: 3 },
    );
    if (exitCode !== 0) {
      return yield* new StartE2eProcessError({
        message: `${command} exited ${exitCode}: ${stderr}`,
      });
    }
    return { stdout, stderr };
  }).pipe(Effect.scoped, Effect.timeout(options.timeout ?? CLEANUP_TIMEOUT_MS));

const StackInspectionSchema = Schema.Struct({
  owner: Schema.String,
  projectRoot: Schema.String,
  runtime: Schema.Struct({ kind: Schema.String }),
  lifecycle: Schema.String,
  database: Schema.optionalKey(Schema.String),
  databaseUrl: Schema.optionalKey(Schema.String),
  hasApi: Schema.Boolean,
});

const LogDataSchema = Schema.Struct({
  found: Schema.Boolean,
  id: Schema.String,
  entries: Schema.Array(Schema.Struct({ source: Schema.String, message: Schema.String })),
});

const FollowEventSchema = Schema.Struct({
  type: Schema.String,
  service: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
});

const VariablesSchema = Schema.Record(Schema.String, Schema.String);

const RetainedLogDataSchema = Schema.Struct({
  found: Schema.Boolean,
  id: Schema.String,
  running: Schema.Boolean,
  entries: Schema.Array(Schema.Struct({ source: Schema.String })),
});

const minimalConfig = `project_id = "compiled-stack-start-e2e"

[experimental]
stack = true

[api]
enabled = false

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
  const script = `
    import { inspectStack, openStack, StackIdSchema } from "@supabase/stack";
    const id = StackIdSchema.make(process.argv.at(-1));
    const inspection = await inspectStack(id);
    const stack = await openStack(id);
    const status = await stack.status();
    const credentials =
      status.lifecycle === "running" ? await stack.credentials() : undefined;
    console.log(JSON.stringify({
      owner: inspection.owner,
      projectRoot: inspection.descriptor.projectRoot,
      runtime: status.runtime,
      lifecycle: status.lifecycle,
      database: status.capabilities.find(({ name }) => name === "database")?.state,
      databaseUrl: credentials?.database.url,
      hasApi: credentials?.api !== undefined,
    }));
  `;
  return Effect.gen(function* () {
    const result = yield* execFileEffect("bun", ["--bun", "-e", script, stackId], {
      env: {
        SUPABASE_HOME: home,
        SUPABASE_NO_KEYRING: "1",
        SUPABASE_TELEMETRY_DISABLED: "1",
      },
      timeout: CLEANUP_TIMEOUT_MS,
    });
    const line = result.stdout.trim().split("\n").at(-1);
    if (line === undefined) {
      return yield* new StartE2eProcessError({
        message: `Stack probe returned no result:\n${result.stderr}`,
      });
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(StackInspectionSchema))(line);
  });
};

const destroyStack = (home: string, stackId: string) => {
  const script = `
    import { openStack, StackIdSchema } from "@supabase/stack";
    const stack = await openStack(StackIdSchema.make(process.argv.at(-1)));
    await stack.destroy();
  `;
  return execFileEffect("bun", ["--bun", "-e", script, stackId], {
    env: {
      SUPABASE_HOME: home,
      SUPABASE_NO_KEYRING: "1",
      SUPABASE_TELEMETRY_DISABLED: "1",
    },
    timeout: CLEANUP_TIMEOUT_MS,
  });
};

const waitForOutput = (
  spawned: ReturnType<typeof spawnSupabase>,
  pattern: RegExp,
  timeoutMs: number,
) =>
  Effect.tryPromise({
    try: () => spawned.waitForOutput(pattern, timeoutMs),
    catch: (cause) =>
      new StartE2eProcessError({ message: "stack logs follower did not produce history", cause }),
  });

describe("stack start (compiled e2e)", () => {
  let home: ReturnType<typeof makeTempHome> | undefined;
  let projectDir: string | undefined;
  let stackId: string | undefined;
  let stackDestroyed = false;

  const cleanup = Effect.gen(function* () {
    let cleanupComplete = stackDestroyed;
    if (!cleanupComplete && home !== undefined) {
      const candidates = yield* readDirectory(join(home.dir, "managed", "stacks")).pipe(
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

          const result = yield* runSupabaseEffect(
            ["stack", "start", "--runtime", "native", "--eager"],
            { cwd: projectDir, home: home.dir, exitTimeoutMs: START_TIMEOUT_MS },
          );
          expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
          const idMatch = result.stdout.match(/Stack ([0-9a-f]{64})/u);
          expect(idMatch, `stdout:\n${result.stdout}`).not.toBeNull();
          stackId = idMatch?.[1];
          const idText = stackId;
          const homeDir = home;
          const projectRoot = projectDir;
          if (idText === undefined || homeDir === undefined || projectRoot === undefined)
            throw new Error("compiled start did not return a stack id");

          const running = yield* inspectStackState(homeDir.dir, idText);
          expect(running.owner).toBe("running");
          expect(running.projectRoot).toBe(yield* realPath(projectRoot));
          expect(running.runtime).toEqual({ kind: "native" });
          expect(running.lifecycle).toBe("running");
          expect(running.database).toBe("ready");
          expect(running.hasApi).toBe(false);
          expect(running.databaseUrl).toMatch(
            /^postgresql:\/\/postgres:.+@127\.0\.0\.1:\d+\/postgres$/,
          );
          const databasePath = join(homeDir.dir, "managed", "stacks", idText, "data", "database");
          yield* access(join(databasePath, "PG_VERSION"));

          const logs = yield* runSupabaseEffect(
            [
              "stack",
              "logs",
              "--stack-id",
              idText,
              "--service",
              "database",
              "--tail",
              "100",
              "--output-format",
              "json",
            ],
            {
              cwd: projectRoot,
              home: homeDir.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs: CLEANUP_TIMEOUT_MS,
            },
          );
          expect(logs.exitCode, `stdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`).toBe(0);
          const logData = yield* Schema.decodeEffect(Schema.fromJsonString(LogDataSchema))(
            logs.stdout,
          );
          expect(logData.found).toBe(true);
          expect(logData.id).toBe(idText);
          expect(logData.entries.length).toBeGreaterThan(0);
          expect(logData.entries.every((entry) => entry.source === "database")).toBe(true);

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
                        "--tail",
                        "1",
                        "--follow",
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
              yield* waitForOutput(
                followed,
                /"type":"log-entry".*"service":"database".*"source":"history"/u,
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
          const historyEntries = followEvents.filter(
            (event) => event.type === "log-entry" && event.source === "history",
          );
          expect(historyEntries).toHaveLength(1);
          expect(historyEntries[0]).toEqual(expect.objectContaining({ service: "database" }));

          const afterFollow = yield* inspectStackState(homeDir.dir, idText);
          expect(afterFollow.owner).toBe("running");
          expect(afterFollow.lifecycle).toBe("running");
          expect(afterFollow.database).toBe("ready");
          const status = yield* runSupabaseEffect(["stack", "status", "--stack-id", idText], {
            cwd: projectRoot,
            home: homeDir.dir,
            exitTimeoutMs: CLEANUP_TIMEOUT_MS,
          });
          expect(status.exitCode, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`).toBe(0);
          expect(status.stdout).toContain(`(${idText})`);
          expect(status.stdout).toContain("Owner: running");
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
          expect(topLevelStatus.stdout).toContain("Owner: running");
          expect(topLevelStatus.stdout).toContain("Lifecycle: running");

          const env = yield* runSupabaseEffect(
            ["stack", "status", "--env", "--stack-id", idText, "--output-format", "json"],
            { cwd: projectRoot, home: homeDir.dir, exitTimeoutMs: CLEANUP_TIMEOUT_MS },
          );
          expect(env.exitCode, `stdout:\n${env.stdout}\nstderr:\n${env.stderr}`).toBe(0);
          const variables = yield* Schema.decodeEffect(Schema.fromJsonString(VariablesSchema))(
            env.stdout,
          );
          expect(Object.keys(variables)).toEqual(["DB_URL"]);
          expect(variables.DB_URL).toMatch(/^postgresql:\/\/postgres:.+@.+:\d+\/postgres$/u);

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
          expect(observed.owner).toBe("absent");
          expect(observed.projectRoot).toBe(yield* realPath(projectRoot));
          expect(observed.runtime).toEqual({ kind: "native" });
          expect(observed.lifecycle).toBe("stopped");
          expect(observed.database).toBe("stopped");

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
          expect(stoppedStatus.stdout).toContain("Owner: absent");
          expect(stoppedStatus.stdout).toContain("Lifecycle: unavailable");
          expect(stoppedStatus.stdout).toContain("Readiness: unknown");

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
          expect(stoppedEnv.stderr).toContain("must be running");

          yield* access(join(databasePath, "PG_VERSION"));

          const retainedLogs = yield* runSupabaseEffect(
            [
              "stack",
              "logs",
              "--stack-id",
              idText,
              "--service",
              "database",
              "--tail",
              "100",
              "--output-format",
              "json",
            ],
            {
              cwd: projectRoot,
              home: homeDir.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs: CLEANUP_TIMEOUT_MS,
            },
          );
          expect(
            retainedLogs.exitCode,
            `stdout:\n${retainedLogs.stdout}\nstderr:\n${retainedLogs.stderr}`,
          ).toBe(0);
          const retainedData = yield* Schema.decodeEffect(
            Schema.fromJsonString(RetainedLogDataSchema),
          )(retainedLogs.stdout);
          expect(retainedData.found).toBe(true);
          expect(retainedData.id).toBe(idText);
          expect(retainedData.running).toBe(false);
          expect(retainedData.entries.length).toBeGreaterThan(0);
          expect(retainedData.entries.every((entry) => entry.source === "database")).toBe(true);

          yield* destroyStack(homeDir.dir, idText);
          stackDestroyed = true;

          const destroyed = yield* Effect.exit(
            access(join(homeDir.dir, "managed", "stacks", idText)),
          );
          expect(Exit.isFailure(destroyed)).toBe(true);
        }),
      ),
  );
});
