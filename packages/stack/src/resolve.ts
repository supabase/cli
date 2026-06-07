import { Effect } from "effect";
import type { BinaryResolver } from "./BinaryResolver.ts";
import type { ChecksumMismatchError } from "./errors.ts";
import type { ServiceName } from "./versions.ts";
import { dockerImageForService } from "./versions.ts";

export type ServiceResolution =
  | { readonly type: "binary"; readonly path: string }
  | { readonly type: "docker"; readonly image: string };

/**
 * Resolve a service to either a native binary path or a Docker image.
 * Tries BinaryResolver first; falls back to Docker on BinaryNotFoundError or DownloadError.
 * ChecksumMismatchError is a real error and propagates.
 */
export const resolveService = (
  resolver: BinaryResolver["Service"],
  service: ServiceName,
  version: string,
): Effect.Effect<ServiceResolution, ChecksumMismatchError> =>
  resolver.resolve({ service, version }).pipe(
    Effect.map((path): ServiceResolution => ({ type: "binary", path })),
    Effect.catchTag("BinaryNotFoundError", () =>
      Effect.succeed<ServiceResolution>({
        type: "docker",
        image: dockerImageForService(service, version),
      }),
    ),
    Effect.catchTag("DownloadError", () =>
      Effect.succeed<ServiceResolution>({
        type: "docker",
        image: dockerImageForService(service, version),
      }),
    ),
  );
