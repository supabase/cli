import { BunServices } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  sequentialExecBatch,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { goldenJson, useShellEnvPin } from "../../../tests/helpers/config-goldens.ts";
import { unusedStackServices } from "../../../tests/helpers/unused-stack.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../command-internal/global-flags.ts";
import { DbConnection, type DbSession } from "../../command-internal/db-connection.service.ts";
import { dockerRunLayer } from "../../command-internal/docker-run.layer.ts";
import { start } from "./start.handler.ts";

const TARGET_REF = "abcdefghijklmnopqrst";
const GOLDEN_DIR = "./testdata/config-precedence/start";
const HEALTHY_STATE = '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}';

const BASE_CONFIG = `project_id = "golden-start"

[api]
port = 55321
schemas = ["public", "base_api"]

[db]
port = 55322

[auth]
site_url = "http://base.example.com"
enable_signup = true

[studio]
port = 55323
`;

const REMOTE_BLOCK = `
[remotes.prod]
project_id = "${TARGET_REF}"

[remotes.prod.api]
schemas = ["public", "remote_api"]

[remotes.prod.auth]
site_url = "http://remote.example.com"
enable_signup = false

[remotes.prod.realtime]
enabled = false
`;

const SHELL_ENV = {
  SUPABASE_API_PORT: "56321",
  SUPABASE_DB_PORT: "56322",
  SUPABASE_API_SCHEMAS: "public,shell_api",
  SUPABASE_AUTH_SITE_URL: "http://shell.example.com",
  SUPABASE_AUTH_ENABLE_SIGNUP: "false",
  SUPABASE_REALTIME_ENABLED: "false",
  SUPABASE_STUDIO_ENABLED: "false",
};

const DOTENV = [
  "SUPABASE_API_PORT=57321",
  "SUPABASE_DB_PORT=57322",
  "SUPABASE_API_SCHEMAS=public,dotenv_api",
  "SUPABASE_AUTH_SITE_URL=http://dotenv.example.com",
  "SUPABASE_AUTH_ENABLE_SIGNUP=false",
  "SUPABASE_REALTIME_ENABLED=false",
  "SUPABASE_STUDIO_ENABLED=false",
  "",
].join("\n");

interface Fixture {
  readonly golden: string;
  readonly name: string;
  readonly config: string;
  readonly shellEnv?: Readonly<Record<string, string>>;
  readonly dotenv?: string;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    golden: "no-overrides",
    name: "start with base config and no env hands containers the base values (pre-refactor)",
    config: BASE_CONFIG,
  },
  {
    golden: "remote-block-ignored",
    name: "start ignores a [remotes.*] block even when its project_id matches a ref (pre-refactor)",
    config: BASE_CONFIG + REMOTE_BLOCK,
    shellEnv: { SUPABASE_REMOTES_PROD_PROJECT_ID: TARGET_REF },
  },
  {
    golden: "shell-env",
    name: "start shell env overrides ports, api schemas, auth settings and service gates (pre-refactor)",
    config: BASE_CONFIG,
    shellEnv: SHELL_ENV,
  },
  {
    golden: "project-dotenv",
    name: "start supabase/.env overrides ports, api schemas, auth settings and service gates (pre-refactor)",
    config: BASE_CONFIG,
    dotenv: DOTENV,
  },
  {
    golden: "shell-beats-dotenv",
    name: "start shell env beats supabase/.env for the same keys (pre-refactor)",
    config: BASE_CONFIG,
    shellEnv: {
      SUPABASE_API_SCHEMAS: "public,shell_api",
      SUPABASE_AUTH_SITE_URL: "http://shell.example.com",
    },
    dotenv: DOTENV,
  },
  {
    golden: "remote-block-with-shell-env",
    name: "start with a [remotes.*] block present and shell env resolves env over base (pre-refactor)",
    config: BASE_CONFIG + REMOTE_BLOCK,
    shellEnv: SHELL_ENV,
  },
];

interface RouteResult {
  readonly exitCode?: number;
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
}

interface CreateRecord {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function concatByteChunks(chunks: ReadonlyArray<unknown>): Uint8Array | undefined {
  let byteLength = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) return undefined;
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) return undefined;
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function containerNameFromCreateArgs(args: ReadonlyArray<string>): string {
  const nameIndex = args.indexOf("--name");
  return nameIndex !== -1 ? (args[nameIndex + 1] ?? "unknown") : "unknown";
}

function mockDockerSpawner() {
  const creates: Array<CreateRecord> = [];
  const copiedFiles: Record<string, string> = {};
  const created = new Set<string>();
  const encoder = new TextEncoder();

  const route = (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "network" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "context" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "create") {
      const name = containerNameFromCreateArgs(args);
      created.add(name);
      return { stdout: [name] };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const id = args[2] ?? "";
      return created.has(id)
        ? { stdout: [HEALTHY_STATE] }
        : { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
    }
    if (args[0] === "ps") return { stdout: [] };
    return { exitCode: 0 };
  };

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = command._tag === "StandardCommand" ? command.args : [];
        const env = command._tag === "StandardCommand" ? (command.options?.env ?? {}) : {};
        const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
        if (args[0] === "create") creates.push({ args, env });

        if (args[0] === "cp" && args[1] === "-" && Stream.isStream(stdin)) {
          const archiveBytes = concatByteChunks(yield* Stream.runCollect(stdin));
          if (archiveBytes !== undefined) {
            const files = yield* Effect.promise(() => new Bun.Archive(archiveBytes).files());
            for (const [filePath, file] of files) {
              copiedFiles[`${args[2] ?? ""}${filePath}`] = yield* Effect.promise(() => file.text());
            }
          }
        }

        const result = route(args);
        const stdout = result.stdout ?? [];
        const stderr = result.stderr ?? [];
        const exitCode = result.exitCode ?? 0;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(5000),
          stdout: Stream.fromIterable(stdout.map((line) => encoder.encode(`${line}\n`))),
          stderr: Stream.fromIterable(stderr.map((line) => encoder.encode(`${line}\n`))),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
  return { layer, creates, copiedFiles };
}

function fakeDbSession(): DbSession {
  const session: DbSession = {
    exec: () => Effect.void,
    query: () => Effect.succeed([]),
    execBatch: (statements) => sequentialExecBatch(session)(statements),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return session;
}

function inlineEnv(args: ReadonlyArray<string>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    args.flatMap((arg, index) =>
      (args[index - 1] === "-e" || args[index - 1] === "--env") && arg.includes("=")
        ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] as const]
        : [],
    ),
  );
}

const STATIC_COPIED_FILES = [
  "/root/index.ts",
  "/home/kong/localhost.crt",
  "/home/kong/localhost.key",
];

function publishedPorts(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg, index) =>
    args[index - 1] === "-p" || args[index - 1] === "--publish" ? [arg] : [],
  );
}

const tempRoot = useTempWorkdir("start-golden-");

describe("start container env precedence goldens", () => {
  const pinShellEnv = useShellEnvPin();

  for (const fixture of FIXTURES) {
    it.live(fixture.name, (ctx) =>
      Effect.gen(function* () {
        const workdir = tempRoot.current;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), fixture.config);
        if (fixture.dotenv !== undefined) {
          yield* fs.writeFileString(path.join(workdir, "supabase", ".env"), fixture.dotenv);
        }
        pinShellEnv(fixture.shellEnv ?? {});

        const docker = mockDockerSpawner();
        const out = mockOutput({ format: "text" });
        const session = fakeDbSession();
        const layer = Layer.mergeAll(
          unusedStackServices,
          BunServices.layer,
          out.layer,
          mockCommandSettings({ workdir }),
          mockTelemetryStateTracked().layer,
          mockAnalytics().layer,
          docker.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
              ),
            ),
          ),
          Layer.succeed(DbConnection, { connect: () => Effect.succeed(session) }),
          dockerRunLayer.pipe(
            Layer.provide(docker.layer),
            Layer.provide(mockProcessControl().layer),
          ),
          mockProcessControl().layer,
          mockRuntimeInfo({ platform: "linux" }),
          Layer.succeed(CommandPlatformApiFactory, {
            make: Effect.die("CommandPlatformApiFactory should not be used by a local start"),
          }),
          Layer.succeed(CliArgs, { args: ["start"] }),
          Layer.succeed(DebugFlag, false),
          Layer.succeed(YesFlag, false),
          Layer.succeed(ExperimentalFlag, false),
          Layer.succeed(NetworkIdFlag, Option.none()),
          mockTty({ stdinIsTty: false }),
          mockStdin(false),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord(
              Object.fromEntries(
                Object.entries(process.env).flatMap(([name, value]) =>
                  value === undefined ? [] : [[name, value]],
                ),
              ),
              { preserveEmptyStrings: true },
            ),
          ),
        );

        yield* start({ exclude: [], ignoreHealthCheck: false, preview: false }).pipe(
          Effect.provide(layer),
        );

        const stagingRoot = path.join(workdir, "supabase", ".temp", "start-secrets");
        const stagedFiles = (yield* fs.readDirectory(stagingRoot, { recursive: true })).filter(
          (file) => file.endsWith("docker.env"),
        );
        const stagedEnvFiles: Record<string, string> = {};
        for (const file of stagedFiles) {
          stagedEnvFiles[file] = yield* fs.readFileString(path.join(stagingRoot, file));
        }

        const containers = Object.fromEntries(
          docker.creates.map((create) => [
            containerNameFromCreateArgs(create.args),
            {
              env: create.env,
              inlineEnv: inlineEnv(create.args),
              publish: publishedPorts(create.args),
            },
          ]),
        );
        const golden = {
          containerOrder: docker.creates.map((create) => containerNameFromCreateArgs(create.args)),
          containers,
          stagedEnvFiles,
          copiedFiles: Object.fromEntries(
            Object.entries(docker.copiedFiles).filter(
              ([key]) => !STATIC_COPIED_FILES.some((file) => key.endsWith(file)),
            ),
          ),
        };
        yield* Effect.promise(() =>
          ctx
            .expect(goldenJson(golden, { [workdir]: "<WORKDIR>" }))
            .toMatchFileSnapshot(`${GOLDEN_DIR}/${fixture.golden}.json`),
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );
  }
});
