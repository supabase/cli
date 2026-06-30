import { parseDockerfileServiceImages } from "./dockerfile-images.ts";

/**
 * Registries the mirror publishes to and the CLI pulls from, mirroring Go's
 * `utils.GetRegistryImageUrls` (`defaultRegistry` + `ghcrRegistry`). An image
 * counts as mirrored only when it exists on EVERY one of these — the mirror
 * pushes to all of them at once, so a tag present on one but not another is a
 * partial mirror that must be re-pushed.
 */
export const MIRROR_REGISTRIES = ["public.ecr.aws", "ghcr.io"] as const;

/**
 * Mirror destination for an upstream image on a single registry, mirroring Go's
 * `utils.GetRegistryImageUrl` (`registry + "/supabase/" + basename`). The
 * upstream org is dropped — every image is mirrored under the `supabase/`
 * namespace — e.g. `postgrest/postgrest:v14.14` -> `ghcr.io/supabase/postgrest:v14.14`.
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

/** Every image pinned in the Dockerfile (each `FROM <image> AS <alias>` line). */
export function dockerfileImages(dockerfile: string): ReadonlyArray<string> {
  return parseDockerfileServiceImages(dockerfile).map((spec) => spec.image);
}

export interface MirrorPartition {
  /** Images present on every mirror registry — nothing to do. */
  readonly mirrored: ReadonlyArray<string>;
  /** Images missing from at least one mirror registry — these need backfilling. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Split images by whether they are fully mirrored — present on EVERY registry in
 * `registries`. An image missing from any one registry lands in `missing` so the
 * backfill re-pushes it everywhere. Every (image, registry) pair is queried, each
 * distinct image once. No image is skipped up front — a `supabase/*` image that is
 * somehow absent is reported just like a third-party one. Idempotent: once an
 * image is on all registries, a re-run skips it.
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
