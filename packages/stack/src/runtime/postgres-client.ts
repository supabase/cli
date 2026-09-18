import { Config, Context, Crypto, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import type { RuntimeArtifactInput } from "../preparation/RuntimeArtifacts.ts";
import {
  ContainerEngineError,
  PostgresClientError,
  type PostgresClientRunError,
} from "../public/Errors.ts";
import { resolvePostgresRelease, type PostgresRelease } from "../model/PostgresRelease.ts";
import type { StackRuntime, StackRuntimePreference } from "../public/Runtime.ts";
import {
  makeProductionRuntimeArtifactPreparer,
  type RuntimeArtifactPreparationError,
} from "../preparation/RuntimeArtifacts.ts";
import { defaultRuntimeEnvironment, StackRuntimeEnvironment } from "../supervisor/Launcher.ts";
import { selectDefaultRuntime, ContainerEngineResolver } from "./ContainerEngineResolver.ts";
import {
  nativePostgresClientEnv,
  postgresClientContainerArgs,
  requiredPostgresClientBins,
  type PostgresClientMount,
} from "./postgres-client-args.ts";

const DATABASE_WORKLOAD_ID = "database:database";
const NATIVE_PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

export interface RunPostgresClientOptions<E> {
  readonly version?: string;
  readonly runtime?: StackRuntimePreference;
  readonly argv: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly mounts?: ReadonlyArray<PostgresClientMount>;
  readonly network?: "host" | { readonly name: string };
  readonly extraHosts?: ReadonlyArray<string>;
  readonly securityOpt?: ReadonlyArray<string>;
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  readonly teeStderr?: boolean;
  readonly captureStderr?: boolean;
}

export interface PostgresClientResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export interface PreparedPostgresClient {
  readonly runtime: StackRuntime;
  readonly version: string;
  readonly artifactRoot?: string;
  readonly image?: string;
}

export class PostgresClientPreparer extends Context.Service<
  PostgresClientPreparer,
  {
    readonly prepare: (
      runtime: StackRuntime,
      release: PostgresRelease,
    ) => Effect.Effect<PreparedPostgresClient, RuntimeArtifactPreparationError>;
  }
>()("@supabase/stack/PostgresClientPreparer") {}

const plannedWorkload = (
  version: string,
  image: string,
  runtime: StackRuntime,
): RuntimeArtifactInput => ({
  id: DATABASE_WORKLOAD_ID,
  recipeId: DATABASE_WORKLOAD_ID,
  capability: "database",
  artifacts: {
    native: { kind: "native", release: version },
    container: { kind: "container", image },
  },
  selected:
    runtime.kind === "native" ? { kind: "native", release: version } : { kind: "container", image },
});

const concatUtf8 = (chunks: ReadonlyArray<Uint8Array>): string => {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
};

const resolvedRuntime = (
  preference: StackRuntimePreference | undefined,
): Effect.Effect<StackRuntime, ContainerEngineError, ChildProcessSpawnerService> =>
  Effect.gen(function* () {
    if (preference !== undefined) {
      return preference.kind === "native"
        ? { kind: "native" }
        : { kind: "container", engine: preference.engine ?? "docker" };
    }
    const resolver = yield* Effect.serviceOption(ContainerEngineResolver);
    return yield* selectDefaultRuntime(Option.getOrUndefined(resolver));
  });

const defaultPrepare = (
  runtime: StackRuntime,
  release: PostgresRelease,
): Effect.Effect<
  PreparedPostgresClient,
  RuntimeArtifactPreparationError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    const envOption = yield* Effect.serviceOption(StackRuntimeEnvironment);
    const env = Option.isSome(envOption) ? envOption.value : yield* defaultRuntimeEnvironment;
    const preparer = yield* makeProductionRuntimeArtifactPreparer({
      stateRoot: env.stateRoot,
      ...(env.artifactCacheRoot === undefined ? {} : { artifactCacheRoot: env.artifactCacheRoot }),
      runtime,
    });
    const prepared = yield* preparer.prepare(
      runtime,
      plannedWorkload(release.version, release.image, runtime),
    );
    return {
      runtime,
      version: release.version,
      ...(prepared.artifactRoot === undefined ? {} : { artifactRoot: prepared.artifactRoot }),
      ...(prepared.image === undefined ? {} : { image: prepared.image }),
    };
  });

const prepareClient = (
  runtime: StackRuntime,
  release: PostgresRelease,
): Effect.Effect<
  PreparedPostgresClient,
  RuntimeArtifactPreparationError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    const override = yield* Effect.serviceOption(PostgresClientPreparer);
    return Option.isSome(override)
      ? yield* override.value.prepare(runtime, release)
      : yield* defaultPrepare(runtime, release);
  });

const requireNativeClientBins = (
  artifactRoot: string,
  argv: ReadonlyArray<string>,
): Effect.Effect<void, PostgresClientError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const bin of requiredPostgresClientBins(argv)) {
      const location = path.join(artifactRoot, "bin", bin);
      const exists = yield* fs.exists(location).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return yield* new PostgresClientError({
          message: `${bin} is missing from the prepared Postgres artifact.`,
          reason: "missing-bin",
          bin,
        });
      }
    }
  });

const streamCommand = <E, SE extends PostgresClientError | ContainerEngineError>(params: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  readonly teeStderr: boolean;
  readonly captureStderr: boolean;
  readonly spawnError: (cause: unknown) => SE;
}): Effect.Effect<PostgresClientResult, E | SE, ChildProcessSpawnerService> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(params.command, [...params.args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        cwd: params.cwd,
        env: params.env,
        extendEnv: true,
      }).pipe(Effect.mapError(params.spawnError));
      const stderrChunks: Array<Uint8Array> = [];
      yield* Effect.all(
        [
          Stream.runForEach(
            handle.stdout.pipe(Stream.mapError(params.spawnError)),
            params.onStdout,
          ),
          Stream.runForEach(handle.stderr, (chunk) =>
            Effect.sync(() => {
              if (params.captureStderr) stderrChunks.push(chunk);
              if (params.teeStderr) globalThis.process.stderr.write(chunk);
            }),
          ).pipe(Effect.mapError(params.spawnError)),
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = yield* handle.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(params.spawnError),
      );
      return { exitCode, stderr: concatUtf8(stderrChunks) };
    }),
  );

const runNative = <E>(
  prepared: PreparedPostgresClient,
  options: RunPostgresClientOptions<E>,
): Effect.Effect<
  PostgresClientResult,
  E | PostgresClientError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const artifactRoot = prepared.artifactRoot;
    if (artifactRoot === undefined)
      return yield* new PostgresClientError({
        message: "Native Postgres client preparation did not produce an artifact root.",
        reason: "missing-bin",
      });
    yield* requireNativeClientBins(artifactRoot, options.argv);
    const env = options.env ?? {};
    const inheritedPath =
      env["PATH"] ??
      Option.getOrUndefined(
        yield* Config.option(Config.string("PATH")).pipe(Effect.orElseSucceed(() => Option.none())),
      );
    const nativeEnv = nativePostgresClientEnv(
      path.join(artifactRoot, "bin"),
      env,
      inheritedPath,
      NATIVE_PATH_DELIMITER,
    );
    const argv = options.argv;
    const command = argv[0];
    if (command === undefined)
      return yield* new PostgresClientError({ message: "Postgres client argv must not be empty." });
    return yield* streamCommand({
      command,
      args: argv.slice(1),
      env: nativeEnv,
      cwd: options.cwd,
      onStdout: options.onStdout,
      teeStderr: options.teeStderr ?? false,
      captureStderr: options.captureStderr ?? true,
      spawnError: () =>
        new PostgresClientError({
          message: `Unable to spawn ${command} from the prepared Postgres artifact.`,
          reason: "spawn",
          bin: command,
        }),
    });
  });

const runContainer = <E>(
  prepared: PreparedPostgresClient,
  options: RunPostgresClientOptions<E>,
): Effect.Effect<
  PostgresClientResult,
  E | PostgresClientError | ContainerEngineError,
  ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    if (prepared.runtime.kind !== "container")
      return yield* new PostgresClientError({
        message: "Container Postgres client preparation did not select a container engine.",
        reason: "spawn",
      });
    const image = prepared.image;
    if (image === undefined)
      return yield* new PostgresClientError({
        message: "Container Postgres client preparation did not produce an image.",
        reason: "spawn",
      });
    const engine = prepared.runtime.engine;
    const env = options.env ?? {};
    return yield* streamCommand({
      command: engine,
      args: postgresClientContainerArgs({
        image,
        argv: options.argv,
        env,
        mounts: options.mounts,
        network: options.network,
        extraHosts: options.extraHosts,
        cwd: options.cwd,
        securityOpt: options.securityOpt,
      }),
      env,
      onStdout: options.onStdout,
      teeStderr: options.teeStderr ?? false,
      captureStderr: options.captureStderr ?? true,
      spawnError: () =>
        new ContainerEngineError({
          message: `Unable to spawn ${engine} for a Postgres client one-shot.`,
          engine,
        }),
    });
  });

/** Runs argv against a prepared catalog Postgres artifact or image. Never starts the server. */
export const runPostgresClient = <E>(
  options: RunPostgresClientOptions<E>,
): Effect.Effect<
  PostgresClientResult,
  E | PostgresClientRunError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    if (options.argv.length === 0)
      return yield* new PostgresClientError({ message: "Postgres client argv must not be empty." });
    const release = yield* resolvePostgresRelease(options.version);
    const runtime = yield* resolvedRuntime(options.runtime);
    const prepared = yield* prepareClient(runtime, release);
    return runtime.kind === "native"
      ? yield* runNative(prepared, options)
      : yield* runContainer(prepared, options);
  });
