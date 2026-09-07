import serviceImagesDockerfile from "../../../../cli-go/pkg/config/templates/Dockerfile" with { type: "text" };
import { slimImageForAlias } from "./slim-images.ts";

export interface DockerfileImageSpec {
  readonly alias: string;
  readonly image: string;
}

const FROM_LINE_PATTERN = /^FROM\s+(.+):([^:\s]+)\s+AS\s+([^\s#]+)/i;

export function parseDockerfileServiceImages(
  dockerfile: string,
): ReadonlyArray<DockerfileImageSpec> {
  return dockerfile
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = FROM_LINE_PATTERN.exec(line);
      if (match === null) {
        return [];
      }

      const [, repository, tag, alias] = match;
      if (repository === undefined || tag === undefined || alias === undefined) {
        return [];
      }

      return [{ alias, image: `${repository}:${tag}` }];
    });
}

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
