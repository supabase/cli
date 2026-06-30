import { parseDockerfileServiceImages } from "./dockerfile-images.ts";

/**
 * Default registry the CLI prefers and that the mirror backfills. Image
 * availability here is what the `Start` CI job validates.
 */
const MIRROR_REGISTRY = "ghcr.io";

/**
 * Mirror destination for an upstream image reference, mirroring Go's
 * `utils.GetRegistryImageUrl` (`registry + "/supabase/" + basename`). The
 * upstream org is dropped — every image is mirrored under the `supabase/`
 * namespace — e.g. `postgrest/postgrest:v14.14` -> `ghcr.io/supabase/postgrest:v14.14`.
 */
export function mirrorImageTarget(image: string, registry: string = MIRROR_REGISTRY): string {
  const basename = image.slice(image.lastIndexOf("/") + 1);
  return `${registry}/supabase/${basename}`;
}

/** Every image pinned in the Dockerfile (each `FROM <image> AS <alias>` line). */
export function dockerfileImages(dockerfile: string): ReadonlyArray<string> {
  return parseDockerfileServiceImages(dockerfile).map((spec) => spec.image);
}

export interface MirrorPartition {
  /** Images whose mirror target already exists — nothing to do. */
  readonly mirrored: ReadonlyArray<string>;
  /** Images missing from the mirror — these need to be backfilled. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Split images by whether their mirror target already exists, querying every
 * distinct image once. This is the idempotent core of the backfill: re-running
 * after a successful mirror returns an empty `missing` list, so mirroring is a
 * no-op. No image is skipped up front — a `supabase/*` image that is somehow
 * absent from the mirror is reported just like a third-party one.
 */
export async function partitionUnmirroredImages(
  images: Iterable<string>,
  isMirrored: (target: string) => Promise<boolean>,
  registry: string = MIRROR_REGISTRY,
): Promise<MirrorPartition> {
  const unique = [...new Set(images)];
  const results = await Promise.all(
    unique.map(async (image) => ({
      image,
      mirrored: await isMirrored(mirrorImageTarget(image, registry)),
    })),
  );

  return {
    mirrored: results.filter((result) => result.mirrored).map((result) => result.image),
    missing: results.filter((result) => !result.mirrored).map((result) => result.image),
  };
}
