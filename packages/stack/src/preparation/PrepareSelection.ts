import { Crypto, Effect, FileSystem, Path } from "effect";
import type { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  artifactServiceKinds,
  type ArtifactError,
  prepareNativeArtifact,
  slimImageMirrors,
  type ArtifactPin,
  type ArtifactSelection,
  type ServiceKind,
} from "../Artifacts.ts";
import { stackError } from "../Rpc.ts";
import {
  makeContainerRuntime,
  resolveEngineTarget,
  type ContainerEngine,
  type ContainerError,
} from "../runtime/Container.ts";

/** One selected service's artifact and whether this call had to fetch it. */
export interface PreparedRelease {
  readonly service: ServiceKind;
  /** The published release, `<upstream>-r<revision>`. */
  readonly release: string;
  readonly outcome: "downloaded" | "cached";
}

const PREPARE_CONCURRENCY = 4;

type Preparer = (
  service: ServiceKind,
  pin: ArtifactPin,
) => Effect.Effect<
  PreparedRelease["outcome"],
  ArtifactError | ContainerError,
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
>;

const releaseOf = (pin: ArtifactPin): string => `${pin.upstreamVersion}-r${pin.revision}`;

const imagePreparer = Effect.fn("Artifacts.imagePreparer")(function* (
  engine: ContainerEngine,
  cacheRoot: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const target = yield* resolveEngineTarget(spawner, engine);
  const runtime = yield* makeContainerRuntime({
    target,
    root: cacheRoot,
    imageMirrors: slimImageMirrors,
  });
  return (_service: ServiceKind, pin: ArtifactPin) =>
    runtime
      .ensureImage(pin.image)
      .pipe(
        Effect.map(({ pulled }): PreparedRelease["outcome"] => (pulled ? "downloaded" : "cached")),
      );
});

/**
 * Fetches every artifact of `selection` that `runtime` runs, without creating or starting a stack:
 * native archives land in the artifact store under `cacheRoot` with their pinned digests verified,
 * and container images are pulled by digest through the selected engine. Artifacts already present
 * are left alone.
 */
export const prepareArtifactSelection = Effect.fn("Artifacts.prepareSelection")(
  function* (
    selection: ArtifactSelection,
    options: {
      readonly runtime: "native" | ContainerEngine;
      readonly cacheRoot: string;
      readonly platform?: { readonly os: string; readonly arch: string };
    },
  ) {
    const prepareOne: Preparer =
      options.runtime === "native"
        ? (service: ServiceKind, pin: ArtifactPin) =>
            prepareNativeArtifact({ service, pin }, options.cacheRoot, options.platform).pipe(
              Effect.map((artifact) => artifact.outcome),
            )
        : yield* imagePreparer(options.runtime, options.cacheRoot);
    const releases = yield* Effect.forEach(
      artifactServiceKinds(),
      (service) =>
        prepareOne(service, selection[service]).pipe(
          Effect.map((outcome): PreparedRelease => ({
            service,
            release: releaseOf(selection[service]),
            outcome,
          })),
        ),
      { concurrency: PREPARE_CONCURRENCY },
    );
    yield* Effect.annotateCurrentSpan({
      "artifact.runtime": options.runtime,
      "artifact.downloaded_count": releases.filter(({ outcome }) => outcome === "downloaded")
        .length,
      "artifact.cached_count": releases.filter(({ outcome }) => outcome === "cached").length,
    });
    return releases;
  },
  Effect.scoped,
  Effect.mapError((cause) => stackError("install", cause)),
);
