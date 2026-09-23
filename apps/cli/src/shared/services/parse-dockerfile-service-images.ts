export interface DockerfileImageSpec {
  readonly alias: string;
  readonly image: string;
}

const FROM_LINE_PATTERN = /^FROM\s+(.+):([^:\s]+)\s+AS\s+([^\s#]+)/i;

/** Reads `FROM <image>:<tag> AS <alias>` lines from the service-image manifest. */
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
