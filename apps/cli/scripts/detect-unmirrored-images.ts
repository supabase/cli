// Detects images pinned in apps/cli-go/pkg/config/templates/Dockerfile that are missing from
// any mirror registry and emits them as JSON, for the mirror-template-images workflow's backfill
// matrix.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { dockerfileServiceImages } from "../src/shared/services/dockerfile-images.ts";

/**
 * Registries the mirror publishes to and the CLI pulls from. An image counts as mirrored only
 * when it exists on every one of these — a tag present on one but not another is a partial
 * mirror that must be re-pushed.
 */
export const MIRROR_REGISTRIES = ["public.ecr.aws", "ghcr.io"] as const;

/**
 * Mirror destination for an upstream image on a single registry. The upstream org is dropped —
 * every image is mirrored under the `supabase/` namespace, e.g.
 * `postgrest/postgrest:v14.14` -> `ghcr.io/supabase/postgrest:v14.14`.
 */
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
  /** Images present on every mirror registry — nothing to do. */
  readonly mirrored: ReadonlyArray<string>;
  /** Images missing from at least one mirror registry — these need backfilling. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Splits images by whether they exist on every registry in `registries`. An image missing from
 * any one registry lands in `missing`, since the backfill must re-push it everywhere; images
 * already mirrored everywhere land in `mirrored` and are skipped by a re-run.
 */
export async function partitionUnmirroredImages(
  images: Iterable<string>,
  isMirrored: (target: string) => Promise<boolean>,
  registries: ReadonlyArray<string> = MIRROR_REGISTRIES,
): Promise<MirrorPartition> {
  const unique = [...new Set(images)];
  const results = await Promise.all(
    unique.map(async (image) => {
      const presence = await Promise.all(
        mirrorImageTargets(image, registries).map((target) => isMirrored(target)),
      );
      return { image, mirrored: presence.every(Boolean) };
    }),
  );

  return {
    mirrored: results.filter((result) => result.mirrored).map((result) => result.image),
    missing: results.filter((result) => !result.mirrored).map((result) => result.image),
  };
}

function imageExistsOnMirror(target: string): Promise<boolean> {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", target], {
    stdio: "ignore",
  });
  return Promise.resolve(result.status === 0);
}

if (import.meta.main) {
  const images = dockerfileServiceImages.map((spec) => spec.image);
  const { mirrored, missing } = await partitionUnmirroredImages(images, imageExistsOnMirror);

  for (const image of mirrored) {
    console.error(`already mirrored: ${image}`);
  }
  for (const image of missing) {
    console.error(`needs mirror: ${image} -> ${mirrorImageTargets(image).join(", ")}`);
  }

  const json = JSON.stringify(missing);
  console.log(json);

  // Expose the list to the workflow as a step output when running in CI.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `missing=${json}\n`);
  }
}
