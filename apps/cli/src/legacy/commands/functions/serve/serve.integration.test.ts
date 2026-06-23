import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Layer, Option, PubSub, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { beforeEach, vi } from "vitest";

import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
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
import type { LegacyFunctionsServeFlags } from "./serve.handler.ts";

const deployMockState = vi.hoisted(() => ({
  isDockerRunning: true,
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
      ) => {
        exitCode: number;
        stdout: string;
        stderr: string;
      }),
  reset() {
    this.isDockerRunning = true;
    this.runCalls = [];
    this.networkCalls = [];
    this.volumeCalls = [];
    this.runHandler = undefined;
  },
}));

vi.mock("../../../../shared/functions/deploy.ts", async () => {
  const actual = await vi.importActual<typeof import("../../../../shared/functions/deploy.ts")>(
    "../../../../shared/functions/deploy.ts",
  );
  const { Effect } = await import("effect");

  return {
    ...actual,
    isDockerRunning: () => Effect.succeed(deployMockState.isDockerRunning),
    ensureDockerNetwork: (networkMode: string, projectId: string) =>
      Effect.sync(() => {
        deployMockState.networkCalls.push({ networkMode, projectId });
      }),
    ensureDockerNamedVolume: (volumeName: string, projectId: string) =>
      Effect.sync(() => {
        deployMockState.volumeCalls.push({ volumeName, projectId });
      }),
    runChildProcess: (command: string, args: ReadonlyArray<string>, options?: unknown) =>
      Effect.sync(() => {
        const envFile = args.flatMap((value, index) =>
          args[index - 1] === "--env-file" ? [value] : [],
        )[0];
        const multilineEnvDir = args
          .flatMap((value, index) => (args[index - 1] === "-v" ? [value] : []))
          .find((value) => value.endsWith(":/root/.supabase/multiline-env:ro"))
          ?.slice(0, -":/root/.supabase/multiline-env:ro".length);
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
        return (
          deployMockState.runHandler?.(command, args, options) ?? {
            exitCode: 0,
            stdout: "",
            stderr: "",
          }
        );
      }),
  };
});

const tempRoot = useLegacyTempWorkdir("supabase-functions-serve-int-");

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
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (condition()) {
        return;
      }
      yield* Effect.sleep(Duration.millis(20));
    }
    return yield* Effect.fail(new Error(message));
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

function mockFileWatcher() {
  const pubsub = Effect.runSync(PubSub.unbounded<ReadonlyArray<FileWatchEvent>>({ replay: 8 }));
  const watchCalls: Array<{ path: string; ignore?: ReadonlyArray<string> }> = [];

  return {
    layer: Layer.succeed(
      FileWatcher,
      FileWatcher.of({
        watch: (path, options) => {
          watchCalls.push({ path, ignore: options?.ignore });
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
  readonly networkId?: Option.Option<string>;
  readonly projectId?: Option.Option<string>;
  readonly processControl?:
    | ReturnType<typeof mockProcessControl>
    | ReturnType<typeof mockQueuedProcessControl>;
  readonly fileWatcher?: ReturnType<typeof mockFileWatcher>;
  readonly childSpawner?: ReturnType<typeof mockDockerLogSpawner>;
}

function setupServe(options: SetupOptions = {}) {
  const out = mockOutput({ format: "text", interactive: false });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
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
      cliConfig,
      telemetry: telemetry.layer,
      runtimeInfo: mockRuntimeInfo({
        cwd: tempRoot.current,
        homeDir: tempRoot.current,
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

async function writeProjectConfig(content: string) {
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
        if (args[0] === "run") {
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
          writeProjectConfig(
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
          (call) => call.command === "docker" && call.args[0] === "run",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker run call");
        }

        expect(dockerRun.args).toContain("--network");
        expect(dockerRun.args).toContain("supabase_network_test-project");
        expect(dockerRun.args).toContain("--add-host");
        expect(dockerRun.args).toContain("host.docker.internal:host-gateway");
        expect(dockerRun.args).toContain("public.ecr.aws/supabase/edge-runtime:v1.73.13");

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
      if (args[0] === "run") {
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
            (call) => call.command === "docker" && call.args[0] === "run",
          );
          if (dockerRun === undefined) {
            throw new Error("expected docker run call before docker logs spawn");
          }
          multilineEnvDirWhenLogsStarted = extractFlagValues(dockerRun.args, "-v")
            .find((value) => value.endsWith(":/root/.supabase/multiline-env:ro"))
            ?.slice(0, -":/root/.supabase/multiline-env:ro".length);
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
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
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
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker run call");
      }

      expect(dockerRun.args.join(" ")).not.toContain(multilineValue);
      expect(dockerRun.args.join(" ")).not.toContain("EOF_ENV_0");

      const multilineBind = extractFlagValues(dockerRun.args, "-v").find((value) =>
        value.endsWith(":/root/.supabase/multiline-env:ro"),
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

  it.live("fails before startup when a multiline env name is not a shell identifier", () => {
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
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
          (call) => call.command === "docker" && call.args[0] === "run",
        ),
      ).toHaveLength(0);
    });
  });

  it.live("sanitizes dotenv parse failures from config env files", () => {
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
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
      if (args[0] === "run") {
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
        writeProjectConfig(
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
          (call) => call.command === "docker" && call.args[0] === "run",
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
      if (args[0] === "run") {
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
        writeProjectConfig(
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
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker run invocation");
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
      if (args[0] === "run") {
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
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
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
            (call) => call.command === "docker" && call.args[0] === "run",
          ).length === 1,
        "timed out waiting for first docker run",
      );

      fileWatcher.emit([
        {
          path: join(tempRoot.current, "supabase", "functions", "hello", "index.ts"),
          type: "update",
        },
      ]);

      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("docker logs exited with 1");
      }

      expect(
        deployMockState.runCalls.filter(
          (call) => call.command === "docker" && call.args[0] === "run",
        ),
      ).toHaveLength(2);
      expect(out.stderrText).toContain("File change detected:");
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
      if (args[0] === "run") {
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
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
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
            (call) => call.command === "docker" && call.args[0] === "run",
          ),
        "timed out waiting for docker run",
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

    return Effect.gen(function* () {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>(() => {
            // Intentionally pending to keep startup in pre-removal work.
          }),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fetchMock.mockRestore();
        }),
      );

      yield* Effect.promise(() =>
        writeProjectConfig(
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

      yield* waitFor(() => fetchMock.mock.calls.length > 0, "timed out waiting for JWKS fetch");
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
      expect(out.stdoutText).toContain("Stopped serving");
    });
  });

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
      if (args[0] === "run") {
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
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
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
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker run call");
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
      if (args[0] === "run") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const childSpawner = mockDockerLogSpawner([{ exitCode: 1, stderr: "template logs failed" }]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
      );
      yield* Effect.promise(() =>
        writeFunctionFile("hello", "index.ts", 'Deno.serve(() => new Response("hello"))\n'),
      );

      const { layer } = setupServe({ childSpawner });
      yield* legacyFunctionsServe(baseFlags()).pipe(Effect.provide(layer), Effect.flip);

      const dockerRun = deployMockState.runCalls.find(
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker run call");
      }

      const commandScript = dockerRun.args[dockerRun.args.length - 1] ?? "";
      expect(commandScript).toContain("cat <<'EOF' > /root/index.ts");
      expect(commandScript).not.toContain("@ts-nocheck");
      expect(commandScript).not.toContain("declare const Deno");
      expect(commandScript).not.toContain("declare const EdgeRuntime");
    });
  });

  it.live("maps the configured inspector_port to the container inspector port", () => {
    deployMockState.runHandler = (command, args) => {
      if (command !== "docker") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (args[0] === "run") {
        return { exitCode: 0, stdout: "edge-runtime-id\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const childSpawner = mockDockerLogSpawner([
      { exitCode: 1, stderr: "inspect port logs failed" },
    ]);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
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
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker run call");
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
      if (args[0] === "run") {
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
        writeProjectConfig(
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
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker run call");
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
          if (args[0] === "run") {
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
          writeProjectConfig(
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
          (call) => call.command === "docker" && call.args[0] === "run",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker run call");
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
      if (args[0] === "run") {
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
        writeProjectConfig(
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
        (call) => call.command === "docker" && call.args[0] === "run",
      );
      expect(dockerRun).toBeDefined();
      if (dockerRun === undefined) {
        throw new Error("expected docker run call");
      }

      const envs = yield* Effect.promise(() => extractDockerEnvEntries(dockerRun));
      expect(envs).toContain("FROM_CONFIG=config-value");
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
      if (args[0] === "run") {
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
        writeProjectConfig([`project_id = "env(${envName})"`, ""].join("\n")),
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
        if (args[0] === "run") {
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
          writeProjectConfig(
            [
              'project_id = "config-project"',
              "",
              "[functions.hello]",
              "verify_jwt = true",
              "",
              "[remotes.override]",
              'project_id = "override-project"',
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
          projectId: Option.some("override-project"),
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
            volumeName: "supabase_edge_runtime_override-project",
            projectId: "override-project",
          },
        ]);
        expect(deployMockState.networkCalls).toEqual([
          {
            networkMode: "supabase_network_override-project",
            projectId: "override-project",
          },
        ]);
        expect(deployMockState.runCalls).toContainEqual(
          expect.objectContaining({
            command: "docker",
            args: ["container", "inspect", "supabase_db_override-project"],
          }),
        );

        const dockerRun = deployMockState.runCalls.find(
          (call) => call.command === "docker" && call.args[0] === "run",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker run call");
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
    deployMockState.isDockerRunning = false;

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
      yield* Effect.promise(() => writeProjectConfig("not valid toml ]["));

      const { layer } = setupServe();
      const error = yield* legacyFunctionsServe(baseFlags()).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(JSON.stringify(error)).toContain("ProjectConfigParseError");
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
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
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
      if (args[0] === "run") {
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
        writeProjectConfig([`project_id = "env(ROOT_PROJECT_ID)"`, ""].join("\n")),
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
        if (args[0] === "run") {
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
          writeProjectConfig(
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
          (call) => call.command === "docker" && call.args[0] === "run",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker run call");
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
        if (args[0] === "run") {
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
          writeProjectConfig(
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
          (call) => call.command === "docker" && call.args[0] === "run",
        );
        expect(dockerRun).toBeDefined();
        if (dockerRun === undefined) {
          throw new Error("expected docker run call");
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
        writeProjectConfig(['project_id = "test-project"', ""].join("\n")),
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
          (call) => call.command === "docker" && call.args[0] === "run",
        ),
      ).toHaveLength(0);
    });
  });
});
