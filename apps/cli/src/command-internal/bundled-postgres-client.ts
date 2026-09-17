import { Context, Crypto, Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  ArtifactIntegrityError,
  ContainerEngineError,
  ContainerEngineResolver,
  ContainerPullError,
  PostgresClientError,
  runPostgresClient,
  selectDefaultRuntime,
  StackPreparationError,
  StackVersionUnsupportedError,
  targetForPlatform,
  type PostgresClientResult,
  type PostgresClientRunError,
  type PostgresClientServices,
  type RunPostgresClientOptions,
  type StackRuntime,
  type StackRuntimePreference,
} from "@supabase/stack/effect";

import { DockerRunError } from "./docker-run.errors.ts";
import { SUGGEST_DOCKER_INSTALL } from "./docker-suggest.ts";
import { HostPostgresClientError } from "./postgres-client.run.ts";
import { ProcessControl } from "../shared/runtime/process-control.service.ts";

const BUNDLED_CLIENT_SUGGESTION =
  "Re-download the Postgres artifact, or create a new stack that uses a container runtime.";

export interface BundledPostgresClientShape {
  readonly run: <E>(
    options: RunPostgresClientOptions<E>,
  ) => Effect.Effect<
    PostgresClientResult,
    E | PostgresClientRunError | HostPostgresClientError | DockerRunError
  >;
}

export class BundledPostgresClient extends Context.Service<
  BundledPostgresClient,
  BundledPostgresClientShape
>()("supabase/cli/BundledPostgresClient") {}

const mapClientFailure = <E>(error: E): E | HostPostgresClientError | DockerRunError => {
  if (error instanceof PostgresClientError) {
    return new HostPostgresClientError({
      message: error.message,
      suggestion: BUNDLED_CLIENT_SUGGESTION,
    });
  }
  if (error instanceof StackVersionUnsupportedError) {
    return new HostPostgresClientError({ message: error.message });
  }
  if (error instanceof StackPreparationError || error instanceof ArtifactIntegrityError) {
    return new HostPostgresClientError({
      message: error.message,
      suggestion: BUNDLED_CLIENT_SUGGESTION,
    });
  }
  if (error instanceof ContainerPullError) {
    return new DockerRunError({
      message: error.message,
      reason: "pull",
      daemonDown: false,
    });
  }
  if (error instanceof ContainerEngineError) {
    return new DockerRunError({
      message:
        error.message.length > 0
          ? error.message
          : `failed to run ${error.engine ?? "docker"}. ${SUGGEST_DOCKER_INSTALL}`,
      reason: "spawn",
      daemonDown: false,
    });
  }
  return error;
};

const clientNeedsContainerRuntime = (platform: string, arch?: string): boolean =>
  platform === "win32" ||
  (arch !== undefined && targetForPlatform({ os: platform, arch }) === undefined);

/** Platforms without a native postgres artifact dump through a one-shot container. */
export const bundledPostgresClientRuntime = (
  stackRuntime: StackRuntime | undefined,
  platform: string,
  arch?: string,
): StackRuntimePreference | undefined => {
  const forceContainer = clientNeedsContainerRuntime(platform, arch);
  if (stackRuntime !== undefined) {
    if (stackRuntime.kind === "native" && forceContainer) {
      return { kind: "container", engine: "docker" };
    }
    return stackRuntime;
  }
  if (forceContainer) return { kind: "container", engine: "docker" };
  return undefined;
};

export const resolveBundledPostgresRuntime = (
  stackRuntime: StackRuntime | undefined,
  platform: string,
  arch?: string,
): Effect.Effect<
  StackRuntimePreference,
  ContainerEngineError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const forced = bundledPostgresClientRuntime(stackRuntime, platform, arch);
    if (forced !== undefined) return forced;
    const resolver = yield* Effect.serviceOption(ContainerEngineResolver);
    return yield* selectDefaultRuntime(Option.getOrUndefined(resolver));
  });

export const bundledPostgresClientLayer: Layer.Layer<
  BundledPostgresClient,
  never,
  PostgresClientServices
> = Layer.effect(
  BundledPostgresClient,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return BundledPostgresClient.of({
      run: (options) =>
        Effect.scoped(
          Effect.gen(function* () {
            const processControl = yield* Effect.serviceOption(ProcessControl);
            if (Option.isSome(processControl)) {
              yield* processControl.value.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
            }
            return yield* runPostgresClient(options);
          }),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(mapClientFailure),
        ),
    });
  }),
);
