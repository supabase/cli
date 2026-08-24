#!/usr/bin/env bun
// Detects which images pinned in apps/cli-go/pkg/config/templates/Dockerfile are
// not yet present on every mirror registry and emits the missing ones as JSON.
// Used by the mirror-template-images workflow to drive the backfill matrix.
import { BunServices } from "@effect/platform-bun";
import { Config, ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { dockerfileServiceImages } from "../src/shared/services/dockerfile-images.ts";

/** Registries the mirror publishes to and the CLI pulls from. */
export const MIRROR_REGISTRIES = ["public.ecr.aws", "ghcr.io"] as const;

/** Mirror destination for an upstream image on a single registry. */
export function mirrorImageTarget(image: string, registry: string): string {
  const basename = image.slice(image.lastIndexOf("/") + 1);
  return `${registry}/supabase/${basename}`;
}

/** Mirror destinations for an upstream image across every mirror registry. */
export function mirrorImageTargets(
  image: string,
  registries: ReadonlyArray<string> = MIRROR_REGISTRIES,
): ReadonlyArray<string> {
  return registries.map((registry) => mirrorImageTarget(image, registry));
}

export interface MirrorPartition {
  readonly mirrored: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
}

/** Split images by whether they are fully mirrored on every registry. */
export function partitionUnmirroredImages<E, R>(
  images: Iterable<string>,
  isMirrored: (target: string) => Effect.Effect<boolean, E, R>,
  registries: ReadonlyArray<string> = MIRROR_REGISTRIES,
): Effect.Effect<MirrorPartition, E, R> {
  return Effect.gen(function* () {
    const unique = [...new Set(images)];
    const results = yield* Effect.forEach(
      unique,
      (image) =>
        Effect.gen(function* () {
          const presence = yield* Effect.forEach(
            mirrorImageTargets(image, registries),
            isMirrored,
            { concurrency: "unbounded" },
          );
          return { image, mirrored: presence.every(Boolean) };
        }),
      { concurrency: "unbounded" },
    );

    return {
      mirrored: results.filter((result) => result.mirrored).map((result) => result.image),
      missing: results.filter((result) => !result.mirrored).map((result) => result.image),
    };
  });
}

const imageExistsOnMirror = (
  target: string,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const result = yield* spawner
      .exitCode(
        ChildProcess.make("docker", ["buildx", "imagetools", "inspect", target], {
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.exit);
    return Exit.isSuccess(result) && result.value === 0;
  });

const writeLine = (stream: "stdout" | "stderr", message: string) =>
  Effect.sync(() => {
    process[stream].write(`${message}\n`);
  });

const appendOutput = (path: string, value: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.open(path, { flag: "a" });
    yield* file.writeAll(new TextEncoder().encode(value));
  }).pipe(Effect.scoped);

const main = Effect.gen(function* () {
  const images = dockerfileServiceImages.map((spec) => spec.image);
  const { mirrored, missing } = yield* partitionUnmirroredImages(images, imageExistsOnMirror);

  yield* Effect.forEach(mirrored, (image) => writeLine("stderr", `already mirrored: ${image}`), {
    discard: true,
  });
  yield* Effect.forEach(
    missing,
    (image) =>
      writeLine("stderr", `needs mirror: ${image} -> ${mirrorImageTargets(image).join(", ")}`),
    { discard: true },
  );

  const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
    missing,
  );
  yield* writeLine("stdout", json);

  const githubOutput = yield* Config.option(Config.string("GITHUB_OUTPUT"));
  if (Option.isSome(githubOutput)) {
    yield* appendOutput(githubOutput.value, `missing=${json}\n`);
  }
});

if (import.meta.main) {
  await Effect.runPromise(
    main.pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
        ),
      ),
    ),
  ).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
