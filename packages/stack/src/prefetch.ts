import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver } from "./BinaryResolver.ts";
import type { ChecksumMismatchError } from "./errors.ts";
import { DockerPullError } from "./errors.ts";
import { type ServiceResolution, resolveService } from "./resolve.ts";
import {
  DEFAULT_VERSIONS,
  type ServiceName,
  type VersionManifest,
  dockerImageForService,
} from "./versions.ts";

export interface PrefetchOptions {
  readonly versions?: Partial<VersionManifest>;
  /** Services to prefetch. Defaults to all. */
  readonly services?: ReadonlyArray<ServiceName>;
  /**
   * Resolution mode. `"auto"` (default) tries native binaries first, pulling Docker images
   * only for services that fall back to Docker. `"docker"` skips binary resolution and
   * pulls Docker images for all services.
   */
  readonly mode?: "auto" | "docker";
}

export type PrefetchResult = Record<string, ServiceResolution>;

export const prefetch = (
  options?: PrefetchOptions,
): Effect.Effect<
  PrefetchResult,
  DockerPullError | ChecksumMismatchError,
  BinaryResolver | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const resolver = yield* BinaryResolver;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const versions = { ...DEFAULT_VERSIONS, ...options?.versions };
    const services: ReadonlyArray<ServiceName> =
      options?.services ?? (["postgres", "postgrest", "auth"] as const);
    const mode = options?.mode ?? "auto";

    type Entry = readonly [string, ServiceResolution];

    const resolveAndPull = (
      service: ServiceName,
    ): Effect.Effect<Entry, DockerPullError | ChecksumMismatchError> => {
      if (mode === "docker") {
        const image = dockerImageForService(service, versions[service]);
        return pullImage(spawner, image).pipe(
          Effect.map((): Entry => [service, { type: "docker", image }]),
        );
      }
      return resolveService(resolver, service, versions[service]).pipe(
        Effect.flatMap((resolution): Effect.Effect<Entry, DockerPullError> => {
          if (resolution.type === "docker") {
            return pullImage(spawner, resolution.image).pipe(
              Effect.map((): Entry => [service, resolution]),
            );
          }
          return Effect.succeed<Entry>([service, resolution]);
        }),
      );
    };

    const results = yield* Effect.all(services.map(resolveAndPull), {
      concurrency: "unbounded",
    });

    return Object.fromEntries(results) as PrefetchResult;
  });

const pullImage = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  image: string,
): Effect.Effect<void, DockerPullError> => {
  const cmd = ChildProcess.make("docker", ["pull", image]);
  return spawner.exitCode(cmd).pipe(
    Effect.flatMap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new DockerPullError({
              image,
              cause: new Error(`docker pull exited with code ${code}`),
            }),
          ),
    ),
    Effect.catchTag("PlatformError", (e) => Effect.fail(new DockerPullError({ image, cause: e }))),
  );
};
