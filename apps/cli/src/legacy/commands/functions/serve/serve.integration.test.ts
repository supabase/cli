import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { beforeEach, vi } from "vitest";

import {
  buildLegacyTestRuntime,
  mockLegacyCliSettings,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { toDockerPath } from "../../../../shared/functions/functions-docker.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import { LegacyDebugFlag, LegacyNetworkIdFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  FileWatcher,
  type FileWatchEvent,
} from "../../../../shared/runtime/file-watcher.service.ts";
import {
  ProcessControl,
  type CliProcessSignal,
} from "../../../../shared/runtime/process-control.service.ts";
import { dockerfileServiceImage } from "../../../../shared/services/dockerfile-images.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import type { LegacyFunctionsServeFlags } from "./serve.handler.ts";

const deployMockState = vi.hoisted(() => ({
  runCalls: [] as Array<{
    command: string;
    args: ReadonlyArray<string>;
    options: unknown;
  }>,
  networkCalls: [] as Array<{
    networkMode: string;
    projectId: string;
  }>,
  volumeCalls: [] as Array<{
    volumeName: string;
    projectId: string;
  }>,
  runHandler: undefined as
    | undefined
    | ((
        command: string,
        args: ReadonlyArray<string>,
        options: unknown,
      ) =>
        | {
            exitCode: number;
            stdout: string;
            stderr: string;
          }
        // Never resolves — lets a test fork+interrupt while this specific call is in flight,
        // matching Effect's own canonical "forever pending, interruptible" primitive.
        | { pending: true }
        // Fails the effect itself — models `spawnContainerCli` failing to spawn
        // any container runtime (neither docker nor podman on PATH), as opposed
        // to a spawned process exiting non-zero.
        | { failure: Error }),
  reset() {
    this.runCalls = [];
    this.networkCalls = [];
    this.volumeCalls = [];
    this.runHandler = undefined;
  },
}));

vi.mock("../../../../shared/functions/functions-docker.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../shared/functions/functions-docker.ts")
  >("../../../../shared/functions/functions-docker.ts");
  const { Effect } = await import("effect");
  const { legacyGetRegistryImageUrl } = await import("../../../shared/legacy-docker-registry.ts");

  return {
    ...actual,
    ensureDockerNetwork: (networkMode: string, projectId: string) =>
      Effect.sync(() => {
        deployMockState.networkCalls.push({ networkMode, projectId });
      }),
    ensureDockerNamedVolume: (volumeName: string, projectId: string) =>
      Effect.sync(() => {
        deployMockState.volumeCalls.push({ volumeName, projectId });
      }),
    // Stubbed to the pure registry-mapping step only, skipping the actual
    // cache-check/pull: the real implementation
    // (`legacyMakeDockerImageResolver`) does `docker image inspect`/`docker
    // pull` via the real `ChildProcessSpawner` directly (not through this
    // file's mocked `runChildProcess` below), so leaving it real here would
    // insert un-mocked spawns — and real 4s/8s retry backoffs on a miss —
    // into every test that reaches container start. Registry
    // resolution/retry has its own coverage in `functions-docker.unit.test.ts`.
    resolveFunctionsDockerImage: (
      image: string,
      projectEnvValues?: Readonly<Record<string, string>>,
    ) => Effect.sync(() => legacyGetRegistryImageUrl(image, projectEnvValues)),
    runChildProcess: (command: string, args: ReadonlyArray<string>, options?: unknown) =>
      Effect.suspend(() => {
        const envFile = args.flatMap((value, index) =>
          args[index - 1] === "--env-file" ? [value] : [],
        )[0];
        const multilineEnvDir = args
          .flatMap((value, index) => (args[index - 1] === "-v" ? [value] : []))
          .find((value) => value.endsWith(":/root/.supabase/multiline-env:ro,Z"))
          ?.slice(0, -":/root/.supabase/multiline-env:ro,Z".length);
        const enrichedOptions =
          envFile === undefined && multilineEnvDir === undefined
            ? options
            : {
                ...(typeof options === "object" && options !== null ? options : {}),
                ...(envFile === undefined
                  ? {}
                  : { envFileContents: readFileSync(envFile, "utf8") }),
                ...(multilineEnvDir === undefined
                  ? {}
                  : {
                      multilineEnvScript: readFileSync(
                        join(multilineEnvDir, "multiline-env.sh"),
                        "utf8",
                      ),
                      multilineEnvFiles: Object.fromEntries(
                        readdirSync(join(multilineEnvDir, "values"))
                          .filter((name) => name.startsWith("env-"))
                          .map((name) => [
                            name,
                            readFileSync(join(multilineEnvDir, "values", name), "utf8"),
                          ]),
                      ),
                    }),
              };
        deployMockState.runCalls.push({ command, args: [...args], options: enrichedOptions });
        const result = deployMockState.runHandler?.(command, args, options) ?? {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
        if ("pending" in result) return Effect.never;
        if ("failure" in result) return Effect.fail(result.failure);
        return Effect.succeed(result);
      }),
  };
});

const tempRoot = useLegacyTempWorkdir("supabase-functions-serve-int-");

// Root bypasses POSIX permission bits, so chmod-based failure tests can't run there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const { legacyFunctionsServe } = await import("./serve.handler.ts");

interface LogProcessBehavior {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly pending?: boolean;
  readonly onSpawn?: () => void;
}

function baseFlags(overrides: Partial<LegacyFunctionsServeFlags> = {}): LegacyFunctionsServeFlags {
  return {
    noVerifyJwt: Option.none(),
    envFile: Option.none(),
    importMap: Option.none(),
    inspect: false,
    inspectMode: Option.none(),
    inspectMain: false,
    all: true,
    ...overrides,
  };
}

function extractFlagValues(args: ReadonlyArray<string>, flag: string) {
  return args.flatMap((value, index) => (args[index - 1] === flag ? [value] : []));
}

async function extractDockerEnvEntries(call: { args: ReadonlyArray<string>; options: unknown }) {
  const values = extractFlagValues(call.args, "-e");
  if (values.some((value) => value.includes("="))) {
    return values;
  }

  const envFile = extractFlagValues(call.args, "--env-file")[0];
  if (envFile !== undefined) {
    const options =
      typeof call.options === "object" && call.options !== null ? call.options : undefined;
    const envFileContents =
      options !== undefined && "envFileContents" in options
        ? (options.envFileContents as string | undefined)
        : undefined;
    const contents = envFileContents ?? (await readFile(envFile, "utf8"));
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  const options =
    typeof call.options === "object" && call.options !== null ? call.options : undefined;
  const env =
    options !== undefined && "env" in options
      ? (options.env as Readonly<Record<string, string>> | undefined)
      : undefined;
  if (env === undefined) {
    return values;
  }
  return values.map((name) => `${name}=${env[name] ?? ""}`);
}

function waitFor(condition: () => boolean, message: string) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 3_000;
    while (!condition()) {
      if (Date.now() >= deadline) {
        return yield* Effect.fail(new Error(message));
      }
      yield* Effect.sleep(Duration.millis(20));
    }
  });
}

function mockQueuedProcessControl() {
  const signals = Effect.runSync(Queue.unbounded<CliProcessSignal>());
  let exitCode: number | undefined;

  return {
    layer: Layer.succeed(
      ProcessControl,
      ProcessControl.of({
        awaitSignal: () => Queue.take(signals),
        awaitShutdown: Effect.never,
        holdSignals: () => Effect.void,
        exit: (code: number) =>
          Effect.gen(function* () {
            exitCode = code;
            return yield* Effect.never;
          }),
        setExitCode: (code: number) =>
          Effect.sync(() => {
            exitCode = code;
          }),
        getExitCode: Effect.sync(() => exitCode),
      }),
    ),
    signal(signal: CliProcessSignal = "SIGINT") {
      Effect.runSync(Queue.offer(signals, signal));
    },
  };
}

function mockFileWatcher(expectedPaths: ReadonlyArray<string> = []) {
  const pubsub = Effect.runSync(PubSub.unbounded<ReadonlyArray<FileWatchEvent>>({ replay: 8 }));
  const expectedWatch = Effect.runSync(Deferred.make<void>());
  const watchCalls: Array<{
    path: string;
    ignore?: ReadonlyArray<string>;
    recursive?: boolean;
  }> = [];

  return {
    layer: Layer.succeed(
      FileWatcher,
      FileWatcher.of({
        watch: (path, options) => {
          watchCalls.push({
            path,
            ignore: options?.ignore,
            recursive: options?.recursive,
          });
          if (
            expectedPaths.every((expectedPath) =>
              watchCalls.some((call) => call.path === expectedPath),
            )
          ) {
            Effect.runSync(Deferred.succeed(expectedWatch, undefined));
          }
          return Stream.fromPubSub(pubsub);
        },
      }),
    ),
    emit(events: ReadonlyArray<FileWatchEvent>) {
      PubSub.publishUnsafe(pubsub, events);
    },
    get watchCalls() {
      return watchCalls;
    },
    awaitExpectedWatch: Deferred.await(expectedWatch),
  };
}

function mockDockerLogSpawner(behaviors: ReadonlyArray<LogProcessBehavior>) {
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let index = 0;

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (command._tag !== "StandardCommand") {
            throw new Error(`unexpected child process kind: ${command._tag}`);
          }

          const record = {
            command: command.command,
            args: [...command.args],
          };
          spawned.push(record);
          const behavior = behaviors[Math.min(index, behaviors.length - 1)] ?? {};
          index += 1;
          behavior.onSpawn?.();

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1_000 + spawned.length),
            exitCode:
              behavior.pending === true
                ? Effect.never
                : Effect.succeed(ChildProcessSpawner.ExitCode(behavior.exitCode ?? 0)),
            isRunning: Effect.succeed(behavior.pending === true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout:
              behavior.stdout === undefined
                ? Stream.empty
                : Stream.make(new TextEncoder().encode(behavior.stdout)),
            stderr:
              behavior.stderr === undefined
                ? Stream.empty
                : Stream.make(new TextEncoder().encode(behavior.stderr)),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    get spawned() {
      return spawned;
    },
  };
}

interface SetupOptions {
  readonly debug?: boolean;
  readonly workdir?: string;
  readonly networkId?: Option.Option<string>;
  readonly projectId?: Option.Option<string>;
  readonly processControl?:
    | ReturnType<typeof mockProcessControl>
    | ReturnType<typeof mockQueuedProcessControl>;
  readonly fileWatcher?: ReturnType<typeof mockFileWatcher>;
  readonly childSpawner?: ReturnType<typeof mockDockerLogSpawner>;
}

function setupServe(options: SetupOptions = {}) {
  const workdir = options.workdir ?? tempRoot.current;
  const out = mockOutput({ format: "text", interactive: false });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cliSettings = mockLegacyCliSettings({
    workdir,
    projectId: options.projectId ?? Option.none(),
  });
  const api = mockLegacyPlatformApiService({ v1: {} });
  const processControl = options.processControl ?? mockProcessControl();
  const fileWatcher = options.fileWatcher ?? mockFileWatcher();
  const childSpawner = options.childSpawner ?? mockDockerLogSpawner([{ exitCode: 1 }]);

  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliSettings,
      telemetry: telemetry.layer,
      runtimeInfo: mockRuntimeInfo({
        cwd: workdir,
        homeDir: workdir,
        platform: "linux",
      }),
      processControl,
    }),
    fileWatcher.layer,
    childSpawner.layer,
    Layer.succeed(LegacyDebugFlag, options.debug ?? false),
    Layer.succeed(LegacyNetworkIdFlag, options.networkId ?? Option.none()),
  );

  return { layer, out, telemetry, processControl, fileWatcher, childSpawner };
}

async function writeCliConfig(content: string) {
  await mkdir(join(tempRoot.current, "supabase"), { recursive: true });
  await writeFile(join(tempRoot.current, "supabase", "config.toml"), content);
}

async function writeFunctionFile(slug: string, relativePath: string, contents: string) {
  const pathname = join(tempRoot.current, "supabase", "functions", slug, relativePath);
  await mkdir(dirname(pathname), { recursive: true });
  await writeFile(pathname, contents);
}

async function writeProjectFile(relativePath: string, contents: string) {
  const pathname = join(tempRoot.current, relativePath);
  await mkdir(dirname(pathname), { recursive: true });
  await writeFile(pathname, contents);
}

beforeEach(() => {
  deployMockState.reset();
});

describe("legacy functions serve integration", () => {
  it.live("overlays each Function's env file on the shared fallback", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "serve logs failed" }]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("world", "index.ts", 'Deno.serve(() => new Response("world"))\n'),
      );
      yield* Effect.promise(() =>
        writeProjectFile(
          join("supabase", "functions", ".env"),
          ["SHARED=shared", "GLOBAL_ONLY=global", ""].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile(
          "hello",
          ".env",
          ["SHARED=hello", "FUNCTION_ONLY=hello", "SUPABASE_SKIP=ignored", ""].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("world", ".env", ["SHARED=world", "FUNCTION_ONLY=world", ""].join("\n")),
      );

      const { layer, out } = setupServe({ childSpawner });
      yield* legacyFunctionsServe(baseFlags()).pipe(Effect.provide(layer), Effect.flip);

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
      expect(envs).toContain("SHARED=shared");
      expect(envs).toContain("GLOBAL_ONLY=global");
      const functionsConfig = envs.find((entry) =>
        entry.startsWith("SUPABASE_INTERNAL_FUNCTIONS_CONFIG="),
      );
      expect(functionsConfig).toBeDefined();
      if (functionsConfig === undefined) {
        throw new Error("missing functions config env");
      }

      expect(
        JSON.parse(functionsConfig.slice("SUPABASE_INTERNAL_FUNCTIONS_CONFIG=".length)),
      ).toEqual({
        hello: expect.objectContaining({
          env: { SHARED: "hello", FUNCTION_ONLY: "hello" },
        }),
        world: expect.objectContaining({
          env: { SHARED: "world", FUNCTION_ONLY: "world" },
        }),
      });
      expect(out.stderrText).toContain(
        "Env name cannot start with SUPABASE_, skipping: SUPABASE_SKIP\n",
      );
    });
  });

  it.live("uses an explicit env file instead of automatic Function env files", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "serve logs failed" }]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() =>
        writeProjectFile(
          join("supabase", "functions", ".env"),
          ["SOURCE=shared", "GLOBAL_ONLY=global", ""].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", ".env", "INVALID-KEY=must-not-be-read\n"),
      );
      yield* Effect.promise(() =>
        writeProjectFile(
          "custom.env",
          ["SOURCE=explicit", "EXPLICIT_ONLY=explicit", ""].join("\n"),
        ),
      );

      const { layer } = setupServe({ childSpawner });
      yield* legacyFunctionsServe(baseFlags({ envFile: Option.some("custom.env") })).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
      expect(envs).toContain("SOURCE=explicit");
      expect(envs).toContain("EXPLICIT_ONLY=explicit");
      expect(envs).not.toContain("GLOBAL_ONLY=global");
      const functionsConfig = envs.find((entry) =>
        entry.startsWith("SUPABASE_INTERNAL_FUNCTIONS_CONFIG="),
      );
      expect(functionsConfig).toBeDefined();
      if (functionsConfig === undefined) {
        throw new Error("missing functions config env");
      }
      expect(
        JSON.parse(functionsConfig.slice("SUPABASE_INTERNAL_FUNCTIONS_CONFIG=".length)),
      ).toEqual({
        hello: {
          verifyJWT: true,
          entrypointPath: "supabase/functions/hello/index.ts",
        },
      });
    });
  });

  it.live("fails before starting the runtime when a Function env file is malformed", () => {
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      const functionEnvPath = join(tempRoot.current, "supabase", "functions", "hello", ".env");
      yield* Effect.promise(() => writeFunctionFile("hello", ".env", "API-KEY=secret-value\n"));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain(`failed to parse environment file: ${functionEnvPath}`);
        expect(error.message).toContain("unexpected character '-' in variable name");
        expect(error.message).not.toContain("secret-value");
        expect(error.message).not.toContain('near "API-KEY=secret-value"');
      }
      expect(
        deployMockState.runCalls.filter(
          (call) => call.command === "docker" && call.args[0] === "create",
        ),
      ).toHaveLength(0);
      expect(deployMockState.networkCalls).toHaveLength(0);
      expect(deployMockState.volumeCalls).toHaveLength(0);
    });
  });

  it.live(
    "starts the runtime from config-defined functions and wires env, binds, and telemetry",
    () => {
      deployMockState.runHandler = (command, args) => {
        if (command !== "docker") {
          throw new Error(`unexpected process: ${command}`);
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
          return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
        }
        if (args[0] === "exec") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected docker args: ${args.join(" ")}`);
      };

      const childSpawner = mockDockerLogSpawner([
        {
          exitCode: 1,
          stderr: "error running container: exit 1",
        },
      ]);

      return Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeCliConfig(
            [
              'project_id = "test-project"',
              "[functions.hello]",
              'entrypoint = "./functions/hello/src/main.ts"',
              'import_map = "./functions/hello/deno.json"',
              'static_files = ["./shared/index.html"]',
              "",
              "[functions.disabled]",
              "enabled = false",
              "",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "src/main.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));
        yield* Effect.promise(() =>
          writeProjectFile("supabase/shared/index.html", "<h1>hello</h1>\n"),
        );
        yield* Effect.promise(() =>
          writeProjectFile(
            join("supabase", "functions", ".env"),
            ["HELLO=WORLD", "SUPABASE_SKIP=1", ""].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeProjectFile(join("supabase", ".temp", "edge-runtime-version"), "1.73.13\n"),
        );

        const { layer, out, telemetry } = setupServe({ childSpawner });

        const error = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain("error running container: exit 1");
        }

        expect(deployMockState.volumeCalls).toEqual([
          {
            volumeName: "supabase_edge_runtime_test-project",
            projectId: "test-project",
          },
        ]);
        expect(deployMockState.networkCalls).toEqual([
          {
            networkMode: "supabase_network_test-project",
            projectId: "test-project",
          },
        ]);
        expect(telemetry.flushed).toBe(true);
        expect(out.stderrText).toContain("Setting up Edge Functions runtime...\n");
        expect(out.stderrText).toContain("Skipped serving Function: disabled\n");

        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "create",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker create call");
        }

        expect(dockerRun.args).toContain("--network");
        expect(dockerRun.args).toContain("supabase_network_test-project");
        expect(dockerRun.args).toContain("--add-host");
        expect(dockerRun.args).toContain("host.docker.internal:host-gateway");
        // The pin's content is applied VERBATIM as the tag (Go's
        // `replaceImageTag`, `pkg/config/utils.go:81-84`) — a bare pin stays
        // bare, no `v` synthesized.
        expect(dockerRun.args).toContain("public.ecr.aws/supabase/edge-runtime:1.73.13");
        // The main service is `docker cp`-streamed in, never a single-file host bind (#6254).
        expect(
          extractFlagValues(dockerRun.args, "-v").some((value) =>
            value.includes(":/root/index.ts"),
          ),
        ).toBe(false);
        const bringUpSteps = deployMockState.runCalls
          .map((call) => call.args[0])
          .filter((step) => step === "create" || step === "cp" || step === "start");
        expect(bringUpSteps).toEqual(["create", "cp", "start"]);
        expect(deployMockState.runCalls.map((call) => call.args.slice(0, 3))).toContainEqual([
          "cp",
          "-",
          "supabase_edge_runtime_test-project:/",
        ]);
        expect(extractFlagValues(dockerRun.args, "--workdir")).toEqual([
          toDockerPath(tempRoot.current),
        ]);
        expect(dockerRun.args[dockerRun.args.length - 1]).toBe(
          "exec edge-runtime start --main-service=/root --port=8081 --policy=per_worker\n",
        );

        const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
        expect(envs).toContain("HELLO=WORLD");
        expect(envs).not.toContain("SUPABASE_SKIP=1");
        const functionsConfig = envs.find((entry) =>
          entry.startsWith("SUPABASE_INTERNAL_FUNCTIONS_CONFIG="),
        );
        expect(functionsConfig).toBeDefined();
        if (functionsConfig === undefined) {
          throw new Error("missing functions config env");
        }

        expect(
          JSON.parse(functionsConfig.slice("SUPABASE_INTERNAL_FUNCTIONS_CONFIG=".length)),
        ).toEqual({
          hello: {
            verifyJWT: true,
            entrypointPath: "supabase/functions/hello/src/main.ts",
            importMapPath: "supabase/functions/hello/deno.json",
            staticFiles: ["supabase/shared/index.html"],
          },
        });

        // The reload must carry bring-up's `--nginx-conf`; a bare `kong reload`
        // re-renders nginx.conf from Kong's default template and drops the
        // `email_templates` server GoTrue fetches (issue #6059).
        expect(deployMockState.runCalls).toContainEqual({
          command: "docker",
          args: [
            "exec",
            "supabase_kong_test-project",
            "kong",
            "reload",
            "--nginx-conf",
            "/home/kong/custom_nginx.template",
          ],
          options: { stdout: "ignore", stderr: "pipe" },
        });

        expect(childSpawner.spawned).toEqual([
          {
            command: "docker",
            args: ["logs", "-f", "--timestamps", "supabase_edge_runtime_test-project"],
          },
        ]);
      });
    },
  );

  it.live("mounts multiline env values without placing their contents in docker argv", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    let multilineEnvDirWhenLogsStarted: string | undefined;
    let multilineEnvDirExistedWhenLogsStarted = false;
    const childSpawner = mockDockerLogSpawner([
      {
        exitCode: 1,
        stderr: "error running container: exit 1",
        onSpawn: () => {
          const dockerRun = deployMockState.runCalls.find(
            (call) => call.command === "docker" && call.args[0] === "create",
          );
          if (dockerRun === undefined) {
            throw new Error("expected docker create call before docker logs spawn");
          }
          multilineEnvDirWhenLogsStarted = extractFlagValues(dockerRun.args, "-v")
            .find((value) => value.endsWith(":/root/.supabase/multiline-env:ro,Z"))
            ?.slice(0, -":/root/.supabase/multiline-env:ro,Z".length);
          multilineEnvDirExistedWhenLogsStarted =
            multilineEnvDirWhenLogsStarted !== undefined &&
            existsSync(multilineEnvDirWhenLogsStarted);
        },
      },
    ]);

    const multilineValue = ["-----BEGIN KEY-----", "EOF_ENV_0", "line-3", "-----END KEY-----"].join(
      "\n",
    );

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() =>
        writeProjectFile(
          join("supabase", "functions", ".env"),
          [`MULTILINE_SECRET="${multilineValue}"`, ""].join("\n"),
        ),
      );

      const { layer } = setupServe({ childSpawner });

      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(Error);

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      expect(dockerRun.args).toContain(
        legacyGetRegistryImageUrl(dockerfileServiceImage("edgeruntime")),
      );
      expect(dockerRun.args.join(" ")).not.toContain(multilineValue);
      expect(dockerRun.args.join(" ")).not.toContain("EOF_ENV_0");

      const multilineBind = extractFlagValues(dockerRun.args, "-v").find((value) =>
        value.endsWith(":/root/.supabase/multiline-env:ro,Z"),
      );
      expect(multilineBind).toBeDefined();
      if (multilineBind === undefined) {
        throw new Error("expected multiline env bind");
      }

      const options =
        typeof dockerRun.options === "object" && dockerRun.options !== null
          ? dockerRun.options
          : undefined;
      const script =
        options !== undefined && "multilineEnvScript" in options
          ? (options.multilineEnvScript as string | undefined)
          : undefined;
      const files =
        options !== undefined && "multilineEnvFiles" in options
          ? (options.multilineEnvFiles as Record<string, string> | undefined)
          : undefined;

      expect(script).toBeDefined();
      expect(files).toBeDefined();
      expect(script).toContain(
        'MULTILINE_SECRET="$(cat /root/.supabase/multiline-env/values/env-0; printf x)"',
      );
      expect(script).toContain('export MULTILINE_SECRET="${MULTILINE_SECRET%x}"');
      expect(script).not.toContain(multilineValue);
      expect(script).not.toContain("EOF_ENV_0");
      expect(files?.["env-0"]).toBe(multilineValue);
      expect(multilineEnvDirWhenLogsStarted).toBeDefined();
      if (multilineEnvDirWhenLogsStarted === undefined) {
        throw new Error("expected multiline env dir when docker logs started");
      }
      expect(multilineEnvDirExistedWhenLogsStarted).toBe(true);
      expect(existsSync(multilineEnvDirWhenLogsStarted)).toBe(false);
    });
  });

  it.live(
    "cleans up a stale multiline-env directory from a previous run even when this run has no multiline secrets",
    () => {
      deployMockState.runHandler = (command, args) => {
        if (command !== "docker") {
          throw new Error(`unexpected process: ${command}`);
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
          return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
        }
        if (args[0] === "exec") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected docker args: ${args.join(" ")}`);
      };

      const childSpawner = mockDockerLogSpawner([
        {
          exitCode: 1,
          stderr: "error running container: exit 1",
        },
      ]);

      const staleMultilineEnvDir = join(
        tempRoot.current,
        "supabase",
        ".temp",
        "start-secrets",
        "supabase_edge_runtime_test-project",
        "multiline-env",
      );

      return Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeCliConfig(['project_id = "test-project"', ""].join("\n")),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() =>
          writeProjectFile(join("supabase", "functions", ".env"), ["HELLO=WORLD", ""].join("\n")),
        );
        // Simulate a stale directory left behind by an earlier run that DID have multiline secrets.
        yield* Effect.promise(async () => {
          await mkdir(join(staleMultilineEnvDir, "values"), { recursive: true, mode: 0o700 });
          await writeFile(join(staleMultilineEnvDir, "multiline-env.sh"), "stale script\n");
          await writeFile(join(staleMultilineEnvDir, "values", "env-0"), "stale secret\n");
        });

        const { layer } = setupServe({ childSpawner });

        const error = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(Error);

        expect(existsSync(staleMultilineEnvDir)).toBe(false);

        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "create",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker create call");
        }
        expect(
          extractFlagValues(dockerRun.args, "-v").some((value) =>
            value.endsWith(":/root/.supabase/multiline-env:ro,Z"),
          ),
        ).toBe(false);
      });
    },
  );

  it.live("fails before startup when a multiline env name is not a shell identifier", () => {
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() =>
        writeProjectFile(
          join("supabase", "functions", ".env"),
          ['FOO.BAR="line-1\nline-2"', ""].join("\n"),
        ),
      );

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("invalid multiline environment variable name");
        expect(error.message).toContain("FOO.BAR");
      }
      expect(
        deployMockState.runCalls.filter(
          (call) => call.command === "docker" && call.args[0] === "create",
        ),
      ).toHaveLength(0);
    });
  });

  it.live("sanitizes dotenv parse failures from config env files", () => {
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() => writeProjectFile(".env.development", "API-KEY=secret-value\n"));
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("failed to parse environment file:");
        expect(error.message).toContain(".env.development");
        expect(error.message).toContain("unexpected character '-' in variable name");
        expect(error.message).not.toContain("secret-value");
        expect(error.message).not.toContain('near "API-KEY=secret-value"');
      }
      expect(deployMockState.runCalls).toHaveLength(0);
    });
  });

  it.live("skips missing unused import map targets during serve startup", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([
      {
        exitCode: 1,
        stderr: "error running container: exit 1",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "[functions.hello]",
            'entrypoint = "./functions/hello/index.ts"',
            'import_map = "./functions/hello/deno.json"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() =>
        writeFunctionFile(
          "hello",
          "deno.json",
          JSON.stringify({
            imports: {
              "unused-alias/": "../missing-shared/",
            },
          }),
        ),
      );

      const { layer } = setupServe({ childSpawner });
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("error running container: exit 1");
      }
      expect(
        deployMockState.runCalls.some(
          (call) => call.command === "docker" && call.args[0] === "create",
        ),
      ).toBe(true);
    });
  });

  it.live("binds deno.json import map references outside the project root", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([
      {
        exitCode: 1,
        stderr: "external import map logs failed",
      },
    ]);

    return Effect.gen(function* () {
      const externalImportMapPath = join(dirname(tempRoot.current), "shared-import-map.json");

      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "[functions.hello]",
            'entrypoint = "./functions/hello/index.ts"',
            'import_map = "./functions/hello/deno.json"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFile(externalImportMapPath, JSON.stringify({ imports: {} })),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() =>
        writeFunctionFile(
          "hello",
          "deno.json",
          JSON.stringify({
            importMap: "../../../../shared-import-map.json",
          }),
        ),
      );

      const { layer } = setupServe({ childSpawner });
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("external import map logs failed");
      }

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create invocation");
      }
      // `buildDockerBinds` realpath-resolves host paths, so compare against the
      // resolved path (on macOS the temp dir lives under /var -> /private/var).
      const resolvedExternalImportMapPath = realpathSync(externalImportMapPath);
      expect(
        extractFlagValues(dockerRun.args, "-v").some(
          (value) =>
            value.startsWith(`${resolvedExternalImportMapPath}:`) &&
            value.endsWith("/shared-import-map.json:ro"),
        ),
      ).toBe(true);
    });
  });

  it.live("binds git-root workspace imports for serve", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([
      {
        exitCode: 1,
        stderr: "workspace import logs failed",
      },
    ]);

    return Effect.gen(function* () {
      const sharedPath = join(tempRoot.current, "packages", "shared", "src", "index.ts");

      yield* Effect.promise(() => mkdir(join(tempRoot.current, ".git"), { recursive: true }));
      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "[functions.hello]",
            'entrypoint = "./functions/hello/index.ts"',
            'import_map = "./functions/hello/deno.json"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeProjectFile("packages/shared/src/index.ts", 'export const shared = "hello"\n'),
      );
      yield* Effect.promise(() =>
        writeFunctionFile(
          "hello",
          "index.ts",
          [
            'import { shared } from "@repo/shared"',
            "Deno.serve(() => new Response(shared))",
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile(
          "hello",
          "deno.json",
          JSON.stringify({
            imports: {
              "@repo/shared": "../../../packages/shared/src/index.ts",
            },
          }),
        ),
      );

      const { layer } = setupServe({ childSpawner });
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("workspace import logs failed");
      }

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create invocation");
      }
      const resolvedSharedPath = realpathSync(sharedPath);
      expect(
        extractFlagValues(dockerRun.args, "-v").some(
          (value) =>
            value.startsWith(`${resolvedSharedPath}:`) &&
            value.endsWith("/packages/shared/src/index.ts:ro"),
        ),
      ).toBe(true);
    });
  });

  it.live("binds per-function deno.json scope targets outside a nested project repository", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const processControl = mockQueuedProcessControl();
    const childSpawner = mockDockerLogSpawner([{ pending: true }]);

    return Effect.gen(function* () {
      const workspaceRoot = tempRoot.current;
      const projectRoot = join(workspaceRoot, "infra", "my-project");
      const rootDenoJson = join(workspaceRoot, "deno.json");
      const libsDir = join(workspaceRoot, "libs");

      yield* Effect.promise(() => mkdir(join(workspaceRoot, ".git"), { recursive: true }));
      yield* Effect.promise(async () => {
        await writeProjectFile(join("infra", "my-project", ".git"), "gitdir: ignored\n");
        await writeProjectFile(
          "deno.json",
          JSON.stringify({
            workspace: ["./libs/*", "./infra/*/supabase/functions/*"],
            imports: { "@acme/thing": "./libs/thing/index.ts" },
          }),
        );
        await writeProjectFile(
          join("infra", "my-project", "supabase", "config.toml"),
          'project_id = "test-project"\n',
        );
        await writeProjectFile(
          join("libs", "thing", "deno.json"),
          JSON.stringify({ name: "@acme/thing", version: "1.0.0", exports: "./index.ts" }),
        );
        await writeProjectFile(join("libs", "thing", "index.ts"), "export const thing = 1\n");
        const functionRelative = join("infra", "my-project", "supabase", "functions", "hello");
        await writeProjectFile(
          join(functionRelative, "index.ts"),
          'import { thing } from "@acme/thing"\nDeno.serve(() => new Response(String(thing)))\n',
        );
        const sharedDenoJson = JSON.stringify({
          imports: { "@std/assert": "jsr:@std/assert@1" },
          scopes: {
            __local: {
              __workspace: "../../../../../deno.json",
              __libs: "../../../../../libs",
            },
          },
        });
        await writeProjectFile(join(functionRelative, "deno.json"), sharedDenoJson);
        const worldRelative = join("infra", "my-project", "supabase", "functions", "world");
        await writeProjectFile(
          join(worldRelative, "index.ts"),
          'import { thing } from "@acme/thing"\nDeno.serve(() => new Response(String(thing)))\n',
        );
        await writeProjectFile(join(worldRelative, "deno.json"), sharedDenoJson);
      });

      const resolvedWorkspaceRoot = realpathSync(workspaceRoot);
      const resolvedLibsDir = realpathSync(libsDir);
      const watchedFunctionsDir = join(projectRoot, "supabase", "functions");
      const fileWatcher = mockFileWatcher([watchedFunctionsDir]);
      const { layer, out } = setupServe({
        childSpawner,
        fileWatcher,
        processControl,
        workdir: projectRoot,
      });
      const fiber = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* fileWatcher.awaitExpectedWatch;

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create invocation");
      }
      const bindValues = extractFlagValues(dockerRun.args, "-v");
      const resolvedRootDenoJson = realpathSync(rootDenoJson);
      expect(bindValues).toContain(`${resolvedRootDenoJson}:${toDockerPath(rootDenoJson)}:ro`);
      expect(bindValues).toContain(`${resolvedLibsDir}:${toDockerPath(libsDir)}:ro`);
      const rootDenoJsonWarn = `WARN: Mounting import map scope target outside the project root: ${resolvedRootDenoJson}\n`;
      const libsWarn = `WARN: Mounting import map scope target outside the project root: ${resolvedLibsDir}\n`;
      expect(out.rawChunks.filter((chunk) => chunk.text === rootDenoJsonWarn)).toEqual([
        { text: rootDenoJsonWarn, stream: "stderr" },
      ]);
      expect(out.rawChunks.filter((chunk) => chunk.text === libsWarn)).toEqual([
        { text: libsWarn, stream: "stderr" },
      ]);
      const watchedPaths = fileWatcher.watchCalls.map((call) => call.path);
      expect(watchedPaths).toContain(watchedFunctionsDir);
      expect(watchedPaths).not.toContain(resolvedWorkspaceRoot);
      expect(watchedPaths).not.toContain(resolvedLibsDir);
      expect(fileWatcher.watchCalls).toContainEqual(
        expect.objectContaining({ path: watchedFunctionsDir, recursive: true }),
      );

      processControl.signal("SIGINT");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  it.live("restarts the runtime when watched files change", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const fileWatcher = mockFileWatcher();
    const childSpawner = mockDockerLogSpawner([
      { pending: true },
      { exitCode: 1, stderr: "docker logs exited with 1" },
    ]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer, out } = setupServe({ fileWatcher, childSpawner });
      const fiber = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* waitFor(
        () =>
          deployMockState.runCalls.filter(
            (call) => call.command === "docker" && call.args[0] === "create",
          ).length === 1,
        "timed out waiting for first docker create",
      );

      fileWatcher.emit([
        {
          path: join(tempRoot.current, "supabase", "functions", "hello", "index.ts"),
          type: "update",
        },
        {
          path: join(tempRoot.current, "supabase", "functions", "hello", "helper.ts"),
          type: "create",
        },
      ]);

      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("docker logs exited with 1");
      }

      expect(
        deployMockState.runCalls.filter(
          (call) => call.command === "docker" && call.args[0] === "create",
        ),
      ).toHaveLength(2);
      // The file-change line prints the fsnotify op token Go prints
      // (`event.Op.String()`, `internal/functions/serve/watcher.go:100`) —
      // WRITE/CREATE/REMOVE — not the internal event-type name.
      expect(out.stderrText).toContain(
        `File change detected: ${join(tempRoot.current, "supabase", "functions", "hello", "index.ts")} (WRITE)`,
      );
      expect(out.stderrText).toContain(
        `File change detected: ${join(tempRoot.current, "supabase", "functions", "hello", "helper.ts")} (CREATE)`,
      );

      // `functions serve`'s restart wrapper (`startEdgeRuntime`, Go's
      // `restartEdgeRuntime`) reloads Kong after each successful bring-up —
      // once for the initial start, once for the file-change-triggered restart.
      expect(
        deployMockState.runCalls.filter(
          (call) =>
            call.command === "docker" &&
            call.args[0] === "exec" &&
            call.args.includes("supabase_kong_test-project") &&
            call.args.includes("reload"),
        ),
      ).toHaveLength(2);
    });
  });

  it.live("stops serving cleanly on a process signal", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const processControl = mockQueuedProcessControl();
    const childSpawner = mockDockerLogSpawner([{ pending: true }]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer, out } = setupServe({ processControl, childSpawner });
      const fiber = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* waitFor(
        () =>
          deployMockState.runCalls.some(
            (call) => call.command === "docker" && call.args[0] === "create",
          ),
        "timed out waiting for docker create",
      );
      processControl.signal("SIGINT");

      const exit = yield* Fiber.await(fiber);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        out.stdoutText
          .replaceAll("\u001b[1m", "")
          .replaceAll("\u001b[22m", "")
          .replaceAll("\\", "/"),
      ).toContain("Stopped serving supabase/functions\n");
    });
  });

  it.live("does not remove the existing runtime when interrupted before startup owns it", () => {
    const processControl = mockQueuedProcessControl();
    // Block startup at the DB assertion (`container inspect`) — the last
    // pre-ownership step under the established ordering (config load →
    // assert DB → only THEN remove the existing container). The remote-JWKS
    // fetch is post-assertion, so if the ordering ever regresses to
    // fetch-first, this test hangs at the pending fetch instead of reaching
    // the inspect and fails on the waitFor timeout.
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { pending: true };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    return Effect.gen(function* () {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>(() => {
            // Intentionally pending — must never be reached before the assertion.
          }),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fetchMock.mockRestore();
        }),
      );

      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "",
            "[auth.third_party.workos]",
            "enabled = true",
            'issuer_url = "https://issuer.example.com"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer, out } = setupServe({ processControl });
      const fiber = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* waitFor(
        () =>
          deployMockState.runCalls.some(
            (call) =>
              call.command === "docker" &&
              call.args[0] === "container" &&
              call.args[1] === "inspect",
          ),
        "timed out waiting for the DB inspect",
      );
      processControl.signal("SIGINT");

      const exit = yield* Fiber.await(fiber);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        deployMockState.runCalls.some(
          (call) =>
            call.command === "docker" &&
            call.args[0] === "container" &&
            call.args[1] === "rm" &&
            call.args.includes("supabase_edge_runtime_test-project"),
        ),
      ).toBe(false);
      // No remote JWKS request either — Go resolves JWKS only after the DB
      // assertion succeeds (`serve.go:141`).
      expect(fetchMock).not.toHaveBeenCalled();
      expect(out.stdoutText).toContain("Stopped serving");
    });
  });

  it.live(
    "cleans up staged secrets when interrupted while reloading Kong after a successful bring-up",
    () => {
      const processControl = mockQueuedProcessControl();
      deployMockState.runHandler = (command, args) => {
        if (command !== "docker") {
          throw new Error(`unexpected process: ${command}`);
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
          return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
        }
        if (args[0] === "exec") {
          // Hangs Kong reload so the interrupt below lands after bring-up succeeded (staged
          // secrets already written, `startedRuntime` already assigned) but before this
          // wrapper's own `reloadKong` call returns.
          return { pending: true };
        }
        throw new Error(`unexpected docker args: ${args.join(" ")}`);
      };

      const childSpawner = mockDockerLogSpawner([{ pending: true }]);

      const stagingDir = join(
        tempRoot.current,
        "supabase",
        ".temp",
        "start-secrets",
        "supabase_edge_runtime_test-project",
      );

      return Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeCliConfig(['project_id = "test-project"', ""].join("\n")),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

        const { layer } = setupServe({ processControl, childSpawner });
        const fiber = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* waitFor(
          () =>
            deployMockState.runCalls.some(
              (call) => call.command === "docker" && call.args[0] === "exec",
            ),
          "timed out waiting for Kong reload to start",
        );
        expect(existsSync(stagingDir)).toBe(true);
        processControl.signal("SIGINT");

        const exit = yield* Fiber.await(fiber);
        expect(Exit.isSuccess(exit)).toBe(true);

        expect(
          deployMockState.runCalls.some(
            (call) =>
              call.command === "docker" &&
              call.args[0] === "container" &&
              call.args[1] === "rm" &&
              call.args.includes("supabase_edge_runtime_test-project"),
          ),
        ).toBe(true);
        expect(existsSync(stagingDir)).toBe(false);
      });
    },
  );

  it.live("passes inspect, debug, and custom network settings through to edge-runtime", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "inspect failed" }]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe({
        debug: true,
        networkId: Option.some("custom-network"),
        childSpawner,
      });

      const error = yield* legacyFunctionsServe(
        baseFlags({
          inspectMode: Option.some("wait"),
          inspectMain: true,
        }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("inspect failed");
      }

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      expect(dockerRun.args).toContain("--network");
      expect(dockerRun.args).toContain("custom-network");
      expect(dockerRun.args).toContain("-p");
      expect(dockerRun.args).toContain("8083:8083");

      const commandScript = dockerRun.args[dockerRun.args.length - 1] ?? "";
      expect(commandScript).toContain("--inspect-wait=0.0.0.0:8083");
      expect(commandScript).toContain("--inspect-main");
      expect(commandScript).toContain("--verbose");

      const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
      expect(envs).toContain("SUPABASE_INTERNAL_DEBUG=true");
      expect(envs).toContain("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=0");
      expect(deployMockState.networkCalls).toEqual([
        { networkMode: "custom-network", projectId: "test-project" },
      ]);
    });
  });

  it.live("injects the Deno runtime template without the TypeScript-only preamble", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "template logs failed" }]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );

      const { layer } = setupServe({ childSpawner });
      yield* legacyFunctionsServe(baseFlags()).pipe(Effect.provide(layer), Effect.flip);

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      const commandScript = dockerRun.args[dockerRun.args.length - 1] ?? "";
      expect(commandScript).toBe(
        "exec edge-runtime start --main-service=/root --port=8081 --policy=per_worker\n",
      );

      const cp = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "cp",
      );
      expect(cp).toBeDefined();
      if (cp === undefined) {
        throw new Error("expected docker cp call");
      }
      const cpOptions: unknown = cp.options;
      const stdin =
        typeof cpOptions === "object" && cpOptions !== null && "stdin" in cpOptions
          ? cpOptions.stdin
          : undefined;
      // Narrows the mock-recorded `unknown`; the `instanceof Uint8Array` check still guards.
      const isCpArchiveStream = (value: unknown): value is Stream.Stream<Uint8Array> =>
        Stream.isStream(value);
      expect(isCpArchiveStream(stdin)).toBe(true);
      if (!isCpArchiveStream(stdin)) return yield* Effect.die("docker cp stdin was not a stream");
      const chunks = yield* Stream.runCollect(stdin);
      const archiveBytes = chunks[0];
      if (!(archiveBytes instanceof Uint8Array)) {
        return yield* Effect.die("docker cp stdin did not contain archive bytes");
      }
      const files = yield* Effect.promise(() => new Bun.Archive(archiveBytes).files());
      const mainService = files.get("root/index.ts");
      if (mainService === undefined) {
        return yield* Effect.die("docker cp archive did not contain root/index.ts");
      }
      const template = yield* Effect.promise(() => mainService.text());
      expect(template.length).toBeGreaterThan(0);
      expect(template).not.toContain("@ts-nocheck");
      expect(template).not.toContain("declare const Deno");
      expect(template).not.toContain("declare const EdgeRuntime");
      expect(commandScript).not.toContain("@ts-nocheck");
    });
  });

  it.live("maps the configured inspector_port to the container inspector port", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const childSpawner = mockDockerLogSpawner([
      { exitCode: 1, stderr: "inspect port logs failed" },
    ]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "",
            "[edge_runtime]",
            'policy = "per_worker"',
            "inspector_port = 9229",
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );

      const { layer } = setupServe({ childSpawner });
      yield* legacyFunctionsServe(baseFlags({ inspect: true })).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      expect(dockerRun.args).toContain("-p");
      expect(dockerRun.args).toContain("9229:8083");
      expect(dockerRun.args).not.toContain("8083:8083");
    });
  });

  it.live("fetches remote jwks for enabled third-party auth providers", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "jwks logs failed" }]);

    return Effect.gen(function* () {
      const remoteKeys = [
        {
          kty: "RSA",
          kid: "remote-key",
          alg: "RS256",
          use: "sig",
          n: "abc",
          e: "AQAB",
        },
      ];

      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://issuer.example/.well-known/openid-configuration") {
          return new Response(JSON.stringify({ jwks_uri: "https://issuer.example/jwks.json" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://issuer.example/jwks.json") {
          return new Response(JSON.stringify({ keys: remoteKeys }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch url: ${url}`);
      });

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fetchMock.mockRestore();
        }),
      );

      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "",
            "[auth.third_party.workos]",
            "enabled = true",
            'issuer_url = "https://issuer.example"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe({ childSpawner });
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("jwks logs failed");
      }

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
      const jwks = envs.find((entry) => entry.startsWith("SUPABASE_JWKS="));
      expect(jwks).toBeDefined();
      if (jwks === undefined) {
        throw new Error("missing SUPABASE_JWKS");
      }

      expect(JSON.parse(jwks.slice("SUPABASE_JWKS=".length))).toEqual({
        keys: expect.arrayContaining([
          expect.objectContaining({ kid: "remote-key" }),
          expect.objectContaining({ kid: "b81269f1-21d8-4f2e-b719-c2240a840d90" }),
          expect.objectContaining({ kty: "oct" }),
        ]),
      });
    });
  });

  it.live(
    "falls back to local jwks when remote jwks resolution fails for enabled third-party auth providers",
    () => {
      return Effect.gen(function* () {
        deployMockState.runHandler = (command, args) => {
          if (command !== "docker") {
            throw new Error(`unexpected process: ${command}`);
          }
          if (args[0] === "container" && args[1] === "inspect") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "container" && args[1] === "rm") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
            return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
          }
          if (args[0] === "exec") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected docker args: ${args.join(" ")}`);
        };

        const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "jwks logs failed" }]);

        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          throw new Error("oidc discovery failed");
        });

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            fetchMock.mockRestore();
          }),
        );

        yield* Effect.promise(() =>
          writeCliConfig(
            [
              'project_id = "test-project"',
              "",
              "[auth.third_party.workos]",
              "enabled = true",
              'issuer_url = "https://issuer.example"',
              "",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

        const { layer } = setupServe({ childSpawner });
        const error = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain("jwks logs failed");
        }

        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "create",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker create call");
        }

        const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
        const jwks = envs.find((entry) => entry.startsWith("SUPABASE_JWKS="));
        expect(jwks).toBeDefined();
        if (jwks === undefined) {
          throw new Error("missing SUPABASE_JWKS");
        }
        expect(JSON.parse(jwks.slice("SUPABASE_JWKS=".length))).toEqual({
          keys: expect.arrayContaining([
            expect.objectContaining({ kid: "b81269f1-21d8-4f2e-b719-c2240a840d90" }),
            expect.objectContaining({ kty: "oct" }),
          ]),
        });
      });
    },
  );

  it.live(
    "does not fail startup on a malformed third-party provider config when auth is disabled",
    () => {
      // `Auth.ThirdParty.validate()` (the "required field" check) only runs inside
      // `Config.Validate`'s `if Auth.Enabled` block — `functions serve`'s own JWKS resolution
      // discards `ResolveJWKS`'s error unconditionally, regardless of `auth.enabled`. So a
      // workos provider enabled without an `issuer_url` must not block startup here.
      deployMockState.runHandler = (command, args) => {
        if (command !== "docker") {
          throw new Error(`unexpected process: ${command}`);
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
          return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
        }
        if (args[0] === "exec") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected docker args: ${args.join(" ")}`);
      };

      const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "jwks logs failed" }]);

      return Effect.gen(function* () {
        const fetchMock = vi.spyOn(globalThis, "fetch");

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            fetchMock.mockRestore();
          }),
        );

        yield* Effect.promise(() =>
          writeCliConfig(
            [
              'project_id = "test-project"',
              "",
              "[auth]",
              "enabled = false",
              "",
              "[auth.third_party.workos]",
              "enabled = true",
              "",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

        const { layer } = setupServe({ childSpawner });
        const error = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain("jwks logs failed");
        }
        expect(fetchMock).not.toHaveBeenCalled();

        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "create",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker create call");
        }

        const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
        const jwks = envs.find((entry) => entry.startsWith("SUPABASE_JWKS="));
        expect(jwks).toBeDefined();
        if (jwks === undefined) {
          throw new Error("missing SUPABASE_JWKS");
        }
        expect(JSON.parse(jwks.slice("SUPABASE_JWKS=".length))).toEqual({
          keys: expect.arrayContaining([
            expect.objectContaining({ kid: "b81269f1-21d8-4f2e-b719-c2240a840d90" }),
            expect.objectContaining({ kty: "oct" }),
          ]),
        });
      });
    },
  );

  it.live("includes config-defined edge runtime secrets in the runtime env", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "secrets logs failed" }]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "",
            "[edge_runtime]",
            'policy = "per_worker"',
            "inspector_port = 8083",
            "",
            "[edge_runtime.secrets]",
            'FROM_CONFIG = "config-value"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe({ childSpawner });
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("secrets logs failed");
      }

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
      expect(envs).toContain("FROM_CONFIG=config-value");
    });
  });

  it.live("uppercases config secret names, skipping empty and unresolved values", () => {
    // The established config loader uppercases every `[edge_runtime.secrets]`
    // key with `strings.ToUpper` (viper #1014 workaround) before
    // `set.ListSecrets` reads the map, and ListSecrets keeps only entries
    // with a non-empty SHA256, i.e. it skips empty values and
    // still-unresolved `env(VAR)` literals.
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "secrets logs failed" }]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "",
            "[edge_runtime.secrets]",
            'my_lower_secret = "keep-me"',
            'EMPTY_SECRET = ""',
            'UNRESOLVED_SECRET = "env(SERVE_SECRET_NEVER_SET)"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe({ childSpawner });
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("secrets logs failed");
      }

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "create",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker create call");
      }

      const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
      expect(envs).toContain("MY_LOWER_SECRET=keep-me");
      expect(envs.some((entry) => entry.startsWith("my_lower_secret="))).toBe(false);
      expect(envs.some((entry) => entry.startsWith("EMPTY_SECRET="))).toBe(false);
      expect(envs.some((entry) => entry.startsWith("UNRESOLVED_SECRET="))).toBe(false);
    });
  });

  it.live("uses the resolved project_id when deriving docker resource names", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "serve logs failed" }]);

    return Effect.gen(function* () {
      const envName = "SUPABASE_SERVE_PROJECT_ID";
      const previous = process.env[envName];
      process.env[envName] = "env-backed-project";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env[envName];
          } else {
            process.env[envName] = previous;
          }
        }),
      );

      yield* Effect.promise(() =>
        writeCliConfig([`project_id = "env(${envName})"`, ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe({ childSpawner });
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("serve logs failed");
      }

      expect(deployMockState.volumeCalls).toEqual([
        {
          volumeName: "supabase_edge_runtime_env-backed-project",
          projectId: "env-backed-project",
        },
      ]);
      expect(deployMockState.networkCalls).toEqual([
        {
          networkMode: "supabase_network_env-backed-project",
          projectId: "env-backed-project",
        },
      ]);
      expect(deployMockState.runCalls).toContainEqual(
        expect.objectContaining({
          command: "docker",
          args: ["container", "inspect", "supabase_db_env-backed-project"],
        }),
      );
    });
  });

  it.live(
    "prefers the legacy SUPABASE_PROJECT_ID override when deriving docker resource names",
    () => {
      deployMockState.runHandler = (command, args) => {
        if (command !== "docker") {
          throw new Error(`unexpected process: ${command}`);
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
          return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
        }
        if (args[0] === "exec") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected docker args: ${args.join(" ")}`);
      };

      const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "serve logs failed" }]);

      return Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeCliConfig(
            [
              'project_id = "config-project"',
              "",
              "[functions.hello]",
              "verify_jwt = true",
              "",
              "[remotes.override]",
              'project_id = "overrideprojectaaaaa"',
              "",
              "[remotes.override.functions.hello]",
              "verify_jwt = false",
              "",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

        const { layer } = setupServe({
          childSpawner,
          projectId: Option.some("overrideprojectaaaaa"),
        });
        const error = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain("serve logs failed");
        }

        expect(deployMockState.volumeCalls).toEqual([
          {
            volumeName: "supabase_edge_runtime_overrideprojectaaaaa",
            projectId: "overrideprojectaaaaa",
          },
        ]);
        expect(deployMockState.networkCalls).toEqual([
          {
            networkMode: "supabase_network_overrideprojectaaaaa",
            projectId: "overrideprojectaaaaa",
          },
        ]);
        expect(deployMockState.runCalls).toContainEqual(
          expect.objectContaining({
            command: "docker",
            args: ["container", "inspect", "supabase_db_overrideprojectaaaaa"],
          }),
        );

        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "create",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker create call");
        }

        const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
        const functionsConfig = envs.find((entry) =>
          entry.startsWith("SUPABASE_INTERNAL_FUNCTIONS_CONFIG="),
        );
        expect(functionsConfig).toBeDefined();
        if (functionsConfig === undefined) {
          throw new Error("missing SUPABASE_INTERNAL_FUNCTIONS_CONFIG");
        }

        expect(
          JSON.parse(functionsConfig.slice("SUPABASE_INTERNAL_FUNCTIONS_CONFIG=".length)),
        ).toEqual(
          expect.objectContaining({
            hello: expect.objectContaining({
              verifyJWT: false,
            }),
          }),
        );
      });
    },
  );

  it.live("fails inspect flag conflicts before startup work begins", () => {
    return Effect.gen(function* () {
      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(
        baseFlags({
          inspect: true,
          inspectMode: Option.some("run"),
        }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain(
          "if any flags in the group [inspect inspect-mode] are set none of the others can be; [inspect inspect-mode] were all set",
        );
      }
      expect(deployMockState.runCalls).toHaveLength(0);
      expect(deployMockState.volumeCalls).toHaveLength(0);
      expect(deployMockState.networkCalls).toHaveLength(0);
    });
  });

  it.live("fails when the project config is malformed", () => {
    return Effect.gen(function* () {
      yield* Effect.promise(() => writeCliConfig("not valid toml ]["));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(JSON.stringify(error)).toContain("CliConfigParseError");
      expect(deployMockState.runCalls).toHaveLength(0);
    });
  });

  it.live("fails when the local database is not running", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Error: No such container: supabase_db_test-project",
        };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("supabase start is not running.");
      }
    });
  });

  it.live("surfaces a down docker daemon as the inspect failure with the install hint", () => {
    // Go has no upfront docker precheck in `functions serve` — a down daemon
    // surfaces from `AssertSupabaseDbIsRunning`'s container inspect as
    // `failed to inspect service: <connection error>` with the Docker Desktop
    // install hint attached as a suggestion (`internal/utils/misc.go:155-166`,
    // `docker.go:350`), AFTER config load resolved the project id.
    const daemonDownStderr =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 1, stdout: "", stderr: daemonDownStderr };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe(`failed to inspect service: ${daemonDownStderr}`);
        // The old TS-only upfront precheck message must never come back.
        expect(error.message).not.toContain("failed to run docker");
      }
      expect(error).toHaveProperty(
        "suggestion",
        "Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop",
      );

      // Config load ran first (the inspect targets the config-resolved project
      // id) and nothing after the failed assert touched docker.
      expect(deployMockState.runCalls).toEqual([
        expect.objectContaining({
          command: "docker",
          args: ["container", "inspect", "supabase_db_test-project"],
        }),
      ]);
      expect(deployMockState.volumeCalls).toHaveLength(0);
      expect(deployMockState.networkCalls).toHaveLength(0);
    });
  });

  it.live("keeps the install hint when no container runtime is installed at all", () => {
    // With no `docker` or `podman` binary on PATH the inspect never spawns —
    // the shell-out equivalent of a missing daemon socket, which
    // `client.IsErrConnectionFailed` classifies as a connection failure and so
    // gets the Docker Desktop install hint. The spawn-failure cause must
    // survive into the `failed to inspect service: …` message instead of
    // being blanked.
    const runtimeNotFoundMessage =
      "docker: command not found (podman also not found) — install Docker Desktop or Podman and ensure it is on PATH";
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { failure: new Error(runtimeNotFoundMessage) };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe(`failed to inspect service: ${runtimeNotFoundMessage}`);
        // The old TS-only upfront precheck message must never come back.
        expect(error.message).not.toContain("failed to run docker");
      }
      expect(error).toHaveProperty(
        "suggestion",
        "Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop",
      );
    });
  });

  it.live("fails with the config error, not a docker error, when both are broken", () => {
    // Established ordering: `restartEdgeRuntime` sanity-checks config load
    // first, `AssertSupabaseDbIsRunning` second — a malformed config wins
    // over a down docker daemon.
    deployMockState.runHandler = () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeCliConfig("not valid toml ]["));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toHaveProperty("_tag", "CliConfigParseError");
      expect(deployMockState.runCalls).toHaveLength(0);
    });
  });

  it.live("makes no remote JWKS request when docker is down", () => {
    // Go only fetches third-party JWKS inside `ServeFunctions` (`serve.go:141`,
    // `ResolveJWKS`), strictly after `AssertSupabaseDbIsRunning`
    // (`serve.go:110-113`) — with a down daemon the docker error surfaces
    // immediately, without first waiting on OIDC/JWKS requests (two sequential
    // 10s-timeout clients, `pkg/config/config.go:1727-1776`).
    const daemonDownStderr =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 1, stdout: "", stderr: daemonDownStderr };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    return Effect.gen(function* () {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        throw new Error(`unexpected fetch before the DB assertion: ${url}`);
      });

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fetchMock.mockRestore();
        }),
      );

      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "",
            "[auth.third_party.workos]",
            "enabled = true",
            'issuer_url = "https://issuer.example"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe(`failed to inspect service: ${daemonDownStderr}`);
      }
      // The docker-down error must win without a single external request.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it.live("fails with the auth config error, not a docker error, when both are broken", () => {
    // Established ordering: the `jwt_secret` ≥16-chars check runs during
    // config load, BEFORE `AssertSupabaseDbIsRunning` — invalid auth config
    // wins over a down docker daemon, so the local half of auth resolution
    // must stay ahead of the DB assertion.
    deployMockState.runHandler = () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(
          ['project_id = "test-project"', "", "[auth]", 'jwt_secret = "short"', ""].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe(
          "Invalid config for auth.jwt_secret. Must be at least 16 characters",
        );
      }
      expect(deployMockState.runCalls).toHaveLength(0);
    });
  });

  it.live("resolves env() config values from root env development files", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "root env logs failed" }]);
    const previousSupabaseEnv = process.env["SUPABASE_ENV"];

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig([`project_id = "env(ROOT_PROJECT_ID)"`, ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeProjectFile(".env.development", "ROOT_PROJECT_ID=root-env-project\n"),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      process.env["SUPABASE_ENV"] = "development";

      const { layer } = setupServe({ childSpawner });
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("root env logs failed");
      }

      expect(deployMockState.volumeCalls).toEqual([
        {
          volumeName: "supabase_edge_runtime_root-env-project",
          projectId: "root-env-project",
        },
      ]);
      expect(deployMockState.networkCalls).toEqual([
        {
          networkMode: "supabase_network_root-env-project",
          projectId: "root-env-project",
        },
      ]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousSupabaseEnv === undefined) {
            delete process.env["SUPABASE_ENV"];
          } else {
            process.env["SUPABASE_ENV"] = previousSupabaseEnv;
          }
        }),
      ),
    );
  });

  it.live(
    "resolves numeric env() config values from root env development files before decode",
    () => {
      deployMockState.runHandler = (command, args) => {
        if (command !== "docker") {
          throw new Error(`unexpected process: ${command}`);
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
          return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
        }
        if (args[0] === "exec") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected docker args: ${args.join(" ")}`);
      };

      const childSpawner = mockDockerLogSpawner([
        { exitCode: 1, stderr: "root api env logs failed" },
      ]);
      const previousSupabaseEnv = process.env["SUPABASE_ENV"];

      return Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeCliConfig(
            ['project_id = "test-project"', "[api]", 'port = "env(ROOT_API_PORT)"', ""].join("\n"),
          ),
        );
        yield* Effect.promise(() => writeProjectFile(".env.development", "ROOT_API_PORT=5544\n"));
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

        process.env["SUPABASE_ENV"] = "development";

        const { layer } = setupServe({ childSpawner });
        const error = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain("root api env logs failed");
        }

        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "create",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker create call");
        }

        const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
        expect(envs).toContain("SUPABASE_INTERNAL_HOST_PORT=5544");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousSupabaseEnv === undefined) {
              delete process.env["SUPABASE_ENV"];
            } else {
              process.env["SUPABASE_ENV"] = previousSupabaseEnv;
            }
          }),
        ),
      );
    },
  );

  it.live(
    "does not publish default jwks fallbacks when signing_keys_path is configured but empty",
    () => {
      deployMockState.runHandler = (command, args) => {
        if (command !== "docker") {
          throw new Error(`unexpected process: ${command}`);
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
          return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
        }
        if (args[0] === "exec") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected docker args: ${args.join(" ")}`);
      };

      const childSpawner = mockDockerLogSpawner([
        { exitCode: 1, stderr: "empty signing keys logs failed" },
      ]);

      return Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeCliConfig(
            [
              'project_id = "test-project"',
              "[auth]",
              'signing_keys_path = "./signing-keys.json"',
              "",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeProjectFile(join("supabase", "signing-keys.json"), "[]\n"),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

        const { layer } = setupServe({ childSpawner });
        const error = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain("empty signing keys logs failed");
        }

        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "create",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker create call");
        }

        const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
        const jwks = envs.find((entry) => entry.startsWith("SUPABASE_JWKS="));
        expect(jwks).toBeDefined();
        if (jwks === undefined) {
          throw new Error("missing SUPABASE_JWKS");
        }

        const parsed = JSON.parse(jwks.slice("SUPABASE_JWKS=".length)) as {
          readonly keys: ReadonlyArray<Record<string, unknown>>;
        };
        expect(
          parsed.keys.some((key) => key["kid"] === "b81269f1-21d8-4f2e-b719-c2240a840d90"),
        ).toBe(false);
        expect(parsed.keys.some((key) => key["kty"] === "oct")).toBe(false);
      });
    },
  );

  it.live("fails when the explicit env file is missing", () => {
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(
        baseFlags({
          envFile: Option.some(".env"),
        }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain(".env");
        expect(error.message).toContain("no such file or directory");
      }
      expect(
        deployMockState.runCalls.filter(
          (call) => call.command === "docker" && call.args[0] === "create",
        ),
      ).toHaveLength(0);
    });
  });

  it.live("surfaces the real filesystem error when the functions path is not a directory", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        writeFileSync(join(tempRoot.current, "supabase", "functions"), "not a directory\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(
          [
            'project_id = "test-project"',
            "[functions.hello]",
            'entrypoint = "./functions/hello/index.ts"',
            "",
          ].join("\n"),
        ),
      );

      const { layer, out } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("ENOTDIR");
        expect(error.message).toContain(join("supabase", "functions"));
        expect(error.message).not.toContain("An error occurred in Effect.tryPromise");
      }
      expect(out.stderrText).toContain("Setting up Edge Functions runtime...\n");
      expect(deployMockState.runCalls.map((call) => call.args.slice(0, 2))).toEqual([
        ["container", "inspect"],
        ["container", "rm"],
      ]);
      expect(
        deployMockState.runCalls.filter(
          (call) => call.command === "docker" && call.args[0] === "create",
        ),
      ).toHaveLength(0);
      expect(deployMockState.networkCalls).toHaveLength(0);
      expect(deployMockState.volumeCalls).toHaveLength(0);
    });
  });

  it.live("preserves the primary error when artifact cleanup also fails", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    };

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      yield* Effect.promise(() =>
        writeProjectFile(
          join("supabase", "functions", ".env"),
          ['FOO.BAR="line-1\nline-2"', ""].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeProjectFile(join("supabase", ".temp", "start-secrets"), "not a directory\n"),
      );

      const { layer, out } = setupServe();
      const exit = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        throw new Error("expected functions serve to fail");
      }
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("invalid multiline environment variable name");
        expect(error.message).toContain("FOO.BAR");
        expect(error.message).not.toContain("ENOTDIR");
        expect(error.message).not.toContain("An error occurred in Effect.tryPromise");
      }
      expect(out.messages).toContainEqual({
        type: "warn",
        message: expect.stringContaining("Failed to clean up Edge Runtime artifacts: ENOTDIR"),
      });
      expect(out.messages).toContainEqual({
        type: "warn",
        message: expect.stringContaining(join("supabase", ".temp", "start-secrets")),
      });
      expect(out.messages).not.toContainEqual({
        type: "warn",
        message: expect.stringContaining("An error occurred in Effect.tryPromise"),
      });
      expect(deployMockState.runCalls.filter((call) => call.args[0] === "create")).toHaveLength(0);
    });
  });

  describe("Config.Validate / dotenv / env-override parity (CLI-1963)", () => {
    it.live(
      "fails before any Docker work when config.toml has an explicit empty project_id",
      () => {
        return Effect.gen(function* () {
          yield* Effect.promise(() => writeCliConfig('project_id = ""\n'));
          yield* Effect.promise(() =>
            writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
          );

          const { layer } = setupServe();
          const error = yield* legacyFunctionsServe(baseFlags()).pipe(
            Effect.provide(layer),
            Effect.flip,
          );

          expect(error).toBeInstanceOf(Error);
          if (error instanceof Error) {
            expect(error.message).toBe("Missing required field in config: project_id");
          }
          expect(deployMockState.runCalls).toHaveLength(0);
          expect(deployMockState.networkCalls).toHaveLength(0);
          expect(deployMockState.volumeCalls).toHaveLength(0);
        });
      },
    );

    it.live(
      "fails before any Docker work on an unrelated Config.Validate branch (unsupported Postgres major version)",
      () => {
        // Proves the WHOLE resolved config is validated, not just `project_id`
        // — `db.major_version = 12` is a genuinely unrelated Go `Config.Validate`
        // branch (`config.go:1034-1062`).
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeCliConfig(
              ['project_id = "test-project"', "", "[db]", "major_version = 12", ""].join("\n"),
            ),
          );
          yield* Effect.promise(() =>
            writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
          );

          const { layer } = setupServe();
          const error = yield* legacyFunctionsServe(baseFlags()).pipe(
            Effect.provide(layer),
            Effect.flip,
          );

          expect(error).toBeInstanceOf(Error);
          if (error instanceof Error) {
            expect(error.message).toBe(
              "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
            );
          }
          expect(deployMockState.runCalls).toHaveLength(0);
          expect(deployMockState.networkCalls).toHaveLength(0);
          expect(deployMockState.volumeCalls).toHaveLength(0);
        });
      },
    );

    it.live(
      "resolves the deno v1 edge-runtime image tag when SUPABASE_EDGE_RUNTIME_DENO_VERSION=1 overrides an unset config value",
      () => {
        deployMockState.runHandler = (command, args) => {
          if (command !== "docker") {
            throw new Error(`unexpected process: ${command}`);
          }
          if (args[0] === "container" && args[1] === "inspect") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "container" && args[1] === "rm") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
            return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
          }
          if (args[0] === "exec") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected docker args: ${args.join(" ")}`);
        };
        const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "serve logs failed" }]);

        return Effect.gen(function* () {
          const previous = process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
          process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "1";
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
              } else {
                process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = previous;
              }
            }),
          );

          yield* Effect.promise(() =>
            writeCliConfig(['project_id = "test-project"', ""].join("\n")),
          );
          yield* Effect.promise(() =>
            writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
          );
          yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

          const { layer } = setupServe({ childSpawner });
          yield* legacyFunctionsServe(baseFlags()).pipe(Effect.provide(layer), Effect.flip);

          const dockerRun = deployMockState.runCalls.find(
            (call) => call.command === "docker" && call.args[0] === "create",
          );
          expect(dockerRun).toBeDefined();
          if (dockerRun === undefined) {
            throw new Error("expected docker create call");
          }
          expect(dockerRun.args).toContain("public.ecr.aws/supabase/edge-runtime:v1.68.4");
        });
      },
    );

    it.live(
      "uses SUPABASE_NETWORK_ID as the docker network when no --network-id flag is passed",
      () => {
        deployMockState.runHandler = (command, args) => {
          if (command !== "docker") {
            throw new Error(`unexpected process: ${command}`);
          }
          if (args[0] === "container" && args[1] === "inspect") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "container" && args[1] === "rm") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
            return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
          }
          if (args[0] === "exec") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected docker args: ${args.join(" ")}`);
        };
        const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "serve logs failed" }]);

        return Effect.gen(function* () {
          const previous = process.env["SUPABASE_NETWORK_ID"];
          process.env["SUPABASE_NETWORK_ID"] = "env-network";
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_NETWORK_ID"];
              } else {
                process.env["SUPABASE_NETWORK_ID"] = previous;
              }
            }),
          );

          yield* Effect.promise(() =>
            writeCliConfig(['project_id = "test-project"', ""].join("\n")),
          );
          yield* Effect.promise(() =>
            writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
          );
          yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

          const { layer } = setupServe({ childSpawner });
          yield* legacyFunctionsServe(baseFlags()).pipe(Effect.provide(layer), Effect.flip);

          expect(deployMockState.networkCalls).toEqual([
            { networkMode: "env-network", projectId: "test-project" },
          ]);
          const dockerRun = deployMockState.runCalls.find(
            (call) => call.command === "docker" && call.args[0] === "create",
          );
          expect(dockerRun?.args).toContain("env-network");
        });
      },
    );

    it.live("prefers an explicit --network-id flag over SUPABASE_NETWORK_ID", () => {
      deployMockState.runHandler = (command, args) => {
        if (command !== "docker") {
          throw new Error(`unexpected process: ${command}`);
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "create" || args[0] === "cp" || args[0] === "start") {
          return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
        }
        if (args[0] === "exec") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected docker args: ${args.join(" ")}`);
      };
      const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "serve logs failed" }]);

      return Effect.gen(function* () {
        const previous = process.env["SUPABASE_NETWORK_ID"];
        process.env["SUPABASE_NETWORK_ID"] = "env-network";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env["SUPABASE_NETWORK_ID"];
            } else {
              process.env["SUPABASE_NETWORK_ID"] = previous;
            }
          }),
        );

        yield* Effect.promise(() =>
          writeCliConfig(['project_id = "test-project"', ""].join("\n")),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        yield* Effect.promise(() => writeFunctionFile("hello", "deno.json", '{"imports":{}}\n'));

        const { layer } = setupServe({ childSpawner, networkId: Option.some("flag-network") });
        yield* legacyFunctionsServe(baseFlags()).pipe(Effect.provide(layer), Effect.flip);

        expect(deployMockState.networkCalls).toEqual([
          { networkMode: "flag-network", projectId: "test-project" },
        ]);
        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "create",
        );
        expect(dockerRun?.args).toContain("flag-network");
        expect(dockerRun?.args).not.toContain("env-network");
      });
    });
  });

  it.live("surfaces the real filesystem error when the fallback env file is unreadable", () => {
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeCliConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );
      // A directory at the fallback path makes the read fail with a non-ENOENT error (EISDIR).
      yield* Effect.promise(() =>
        mkdir(join(tempRoot.current, "supabase", "functions", ".env"), { recursive: true }),
      );

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("EISDIR");
        expect(error.message).not.toContain("An error occurred in Effect.tryPromise");
      }
      expect(
        deployMockState.runCalls.filter(
          (call) => call.command === "docker" && call.args[0] === "create",
        ),
      ).toHaveLength(0);
    });
  });

  it.live.skipIf(isRoot)(
    "surfaces the real filesystem error when the env staging dir cannot be created",
    () => {
      return Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeCliConfig(['project_id = "test-project"', ""].join("\n")),
        );
        yield* Effect.promise(() =>
          writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
        );
        // A read-only parent makes the per-container staging-dir mkdir fail with EACCES.
        const stagingRoot = join(tempRoot.current, "supabase", ".temp", "start-secrets");
        yield* Effect.promise(() => mkdir(stagingRoot, { recursive: true }));
        yield* Effect.promise(() => chmod(stagingRoot, 0o555));

        const { layer } = setupServe();
        const error = yield* legacyFunctionsServe(baseFlags()).pipe(
          Effect.provide(layer),
          Effect.flip,
          Effect.ensuring(Effect.promise(() => chmod(stagingRoot, 0o755))),
        );

        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain("EACCES");
          expect(error.message).not.toContain("An error occurred in Effect.tryPromise");
        }
        expect(
          deployMockState.runCalls.filter(
            (call) => call.command === "docker" && call.args[0] === "create",
          ),
        ).toHaveLength(0);
      });
    },
  );
});
