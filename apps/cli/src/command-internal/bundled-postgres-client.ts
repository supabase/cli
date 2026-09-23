import {
  Context,
  Config,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  ArtifactError,
  postgresVersion,
  prepareNativeArtifact,
  resolveArtifact,
} from "@supabase/stack/internal/postgres-artifact";

import { DockerRun, type DockerRunOpts } from "./docker-run.service.ts";
import { DockerRunError } from "./docker-run.errors.ts";
import { HostPostgresClientError } from "./postgres-client.run.ts";
import { ProcessControl } from "../shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";

const BUNDLED_CLIENT_SUGGESTION =
  "Re-download the Postgres artifact, or create a new stack that uses a container runtime.";

export type StackRuntimePreference =
  | { readonly kind: "native" }
  | { readonly kind: "container"; readonly engine: "docker" | "podman" };
export type StackRuntime = StackRuntimePreference;

interface PostgresClientMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

interface PostgresClientResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export interface RunPostgresClientOptions<E> {
  readonly version?: string;
  readonly runtime?: StackRuntimePreference;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly mounts?: ReadonlyArray<PostgresClientMount>;
  readonly network?: "host" | { readonly name: string };
  readonly extraHosts?: ReadonlyArray<string>;
  readonly securityOpt?: ReadonlyArray<string>;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  readonly teeStderr?: boolean;
  readonly captureStderr?: boolean;
}

type PostgresClientRunError = DockerRunError;

export interface BundledPostgresClientShape {
  readonly run: <E>(
    options: RunPostgresClientOptions<E>,
  ) => Effect.Effect<PostgresClientResult, E | PostgresClientRunError | HostPostgresClientError>;
}

export class BundledPostgresClient extends Context.Service<
  BundledPostgresClient,
  BundledPostgresClientShape
>()("supabase/cli/BundledPostgresClient") {}

const clientNeedsContainerRuntime = (platform: string, arch?: string): boolean =>
  platform === "win32" ||
  !(
    (platform === "darwin" && arch === "arm64") ||
    (platform === "linux" && (arch === "x64" || arch === "arm64"))
  );

export const bundledPostgresClientRuntime = (
  stackRuntime: StackRuntime | "native" | "docker" | "podman" | undefined,
  platform: string,
  arch?: string,
): StackRuntimePreference | undefined => {
  const forceContainer = clientNeedsContainerRuntime(platform, arch);
  if (stackRuntime !== undefined) {
    const selected: StackRuntimePreference =
      typeof stackRuntime === "string"
        ? stackRuntime === "native"
          ? { kind: "native" }
          : { kind: "container", engine: stackRuntime }
        : stackRuntime;
    if (selected.kind === "native" && forceContainer)
      return { kind: "container", engine: "docker" };
    return selected;
  }
  return forceContainer ? { kind: "container", engine: "docker" } : { kind: "native" };
};

export const resolveBundledPostgresRuntime = (
  stackRuntime: StackRuntime | "native" | "docker" | "podman" | undefined,
  platform: string,
  arch?: string,
): Effect.Effect<StackRuntimePreference> =>
  Effect.succeed(bundledPostgresClientRuntime(stackRuntime, platform, arch) ?? { kind: "native" });

const mapArtifactError = (error: ArtifactError): HostPostgresClientError =>
  new HostPostgresClientError({
    message: error.message,
    ...(error.cause === undefined ? {} : { suggestion: BUNDLED_CLIENT_SUGGESTION }),
  });

const mapSpawnError = (error: unknown): HostPostgresClientError =>
  new HostPostgresClientError({
    message: `Unable to run the bundled PostgreSQL client: ${error instanceof Error ? error.message : String(error)}`,
    suggestion: BUNDLED_CLIENT_SUGGESTION,
  });

const nativeRun = Effect.fn("BundledPostgresClient.nativeRun")(function* <E>(
  options: RunPostgresClientOptions<E>,
  artifactRoot: string,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  output: Output["Service"],
) {
  const [command, ...args] = options.argv;
  if (command === undefined)
    return yield* new HostPostgresClientError({ message: "PostgreSQL client command is empty." });
  const tool = ["pg_dump", "pg_dumpall", "pg_prove", "psql"].includes(command)
    ? path.join(artifactRoot, "bin", command)
    : command;
  const inheritedPath = yield* Config.option(Config.string("PATH")).pipe(
    Effect.mapError(mapSpawnError),
  );
  const env = {
    ...options.env,
    PATH: `${path.join(artifactRoot, "bin")}:${Option.getOrElse(inheritedPath, () => "")}`,
  };
  const child = yield* spawner
    .spawn(
      ChildProcess.make(tool, args, {
        cwd: options.cwd,
        env,
        extendEnv: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: command === "pg_prove" ? "SIGKILL" : undefined,
        forceKillAfter: "5 seconds",
      }),
    )
    .pipe(Effect.mapError(mapSpawnError));
  let stderr = "";
  const stderrDecoder = new TextDecoder();
  yield* Effect.all(
    [
      Stream.runForEach(child.stdout, (chunk: Uint8Array) => options.onStdout(chunk)),
      Stream.runForEach(child.stderr, (chunk: Uint8Array) =>
        Effect.gen(function* () {
          if (options.teeStderr === true) yield* output.rawBytes(chunk, "stderr");
          if (options.captureStderr !== false)
            stderr += stderrDecoder.decode(chunk, { stream: true });
        }),
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError((error) =>
      error instanceof PlatformError.PlatformError ? mapSpawnError(error) : error,
    ),
  );
  if (options.captureStderr !== false) stderr += stderrDecoder.decode();
  return { exitCode: yield* child.exitCode.pipe(Effect.mapError(mapSpawnError)), stderr };
});

const dockerRun = Effect.fn("BundledPostgresClient.dockerRun")(function* <E>(
  options: RunPostgresClientOptions<E>,
  image: string,
  docker: DockerRun["Service"],
) {
  const dockerOptions: DockerRunOpts = {
    image,
    cmd: options.argv,
    env: options.env,
    projectEnvValues: options.projectEnvValues,
    binds: (options.mounts ?? []).map(
      (mount) => `${mount.source}:${mount.target}${mount.readOnly === true ? ":ro" : ""}`,
    ),
    workingDir: options.cwd === undefined ? Option.none() : Option.some(options.cwd),
    securityOpt: options.securityOpt ?? [],
    extraHosts: options.extraHosts ?? [],
    network:
      options.network === undefined || options.network === "host"
        ? { _tag: "host" }
        : { _tag: "named", name: options.network.name },
    skipImageResolve: true,
  };
  return yield* docker.runStream(dockerOptions, {
    onStdout: options.onStdout,
    teeStderr: options.teeStderr,
    captureStderr: options.captureStderr,
  });
});

export const bundledPostgresClientLayer: Layer.Layer<
  BundledPostgresClient,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | DockerRun
  | RuntimeInfo
  | ProcessControl
  | Output
  | CommandSettings
> = Layer.effect(
  BundledPostgresClient,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const docker = yield* DockerRun;
    const runtimeInfo = yield* RuntimeInfo;
    const settings = yield* CommandSettings;
    const processControl = yield* ProcessControl;
    const output = yield* Output;
    const run = Effect.fn("BundledPostgresClient.run")(function* <E>(
      options: RunPostgresClientOptions<E>,
    ) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
          const runtime = options.runtime ?? { kind: "native" };
          const version = postgresVersion(options.version ?? "17");
          if (runtime.kind === "container") {
            const resolved = yield* resolveArtifact({ service: "database", version }).pipe(
              Effect.mapError(mapArtifactError),
            );
            return yield* dockerRun(options, resolved.image, docker);
          }
          const prepared = yield* prepareNativeArtifact(
            { service: "database", version },
            path.join(settings.supabaseHome, "cache", "stack"),
            { os: runtimeInfo.platform, arch: runtimeInfo.arch },
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(mapArtifactError),
          );
          return yield* nativeRun(options, prepared.root, path, spawner, output);
        }),
      );
    });
    return BundledPostgresClient.of({ run });
  }),
);
