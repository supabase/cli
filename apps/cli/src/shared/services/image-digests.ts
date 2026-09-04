import { IMAGE_DIGESTS } from "./image-digests.generated.ts";
import { isSlimImageRef } from "./slim-images.ts";

const digestsByName = new Map(
  Object.entries(IMAGE_DIGESTS).map(([image, digest]) => [imageName(image), digest] as const),
);

function imageName(image: string): string {
  return image.slice(image.lastIndexOf("/") + 1);
}

/** The pinned index digest of a Dockerfile image on any registry, matched by its `name:tag` segment; slim builds are never pinned. */
export function imageDigest(image: string): string | undefined {
  return isSlimImageRef(image) ? undefined : digestsByName.get(imageName(image));
}
