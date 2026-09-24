import serviceImagesDockerfile from "./Dockerfile" with { type: "text" };
import {
  parseDockerfileServiceImages,
  type DockerfileImageSpec,
} from "./parse-dockerfile-service-images.ts";
import { slimImageForAlias } from "./slim-images.ts";

export { parseDockerfileServiceImages, type DockerfileImageSpec };

export const dockerfileServiceImages = parseDockerfileServiceImages(serviceImagesDockerfile);

/** The docker.io reference exactly as pinned in the Dockerfile manifest. */
export function dockerfileServiceImageRaw(alias: string): string {
  const service = dockerfileServiceImages.find((image) => image.alias === alias);
  if (service === undefined) {
    throw new Error(`Missing service image alias '${alias}' in Dockerfile manifest.`);
  }

  return service.image;
}

/**
 * The default image for `alias`, rewritten to its slim `ghcr.io/supabase/cli`
 * equivalent when `SUPABASE_USE_SLIM_IMAGES` is set. This is the single choke
 * point for default service images; use `dockerfileServiceImageRaw` where the
 * docker.io identity itself is the contract (user-facing short names).
 */
export function dockerfileServiceImage(alias: string): string {
  return slimImageForAlias(alias, dockerfileServiceImageRaw(alias));
}
