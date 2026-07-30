import { Effect } from "effect";
import type { BinaryResolver } from "./BinaryResolver.ts";
import type { BinaryNotFoundError, ChecksumMismatchError, DownloadError } from "./errors.ts";
import type { ServiceName } from "./versions.ts";
import { dockerImageForService } from "./versions.ts";

export type ServiceResolution =
  | { readonly type: "binary"; readonly path: string }
  | { readonly type: "docker"; readonly image: string };

/**
 * Resolve a service to either a native binary path or a Docker image.
 * Tries BinaryResolver first; in `"auto"` mode BinaryNotFoundError/DownloadError
 * fall back to Docker, while `"native"` mode propagates them — native requires
 * native binaries. ChecksumMismatchError always propagates.
 */
export const resolveService = (
  resolver: BinaryResolver["Service"],
  service: ServiceName,
  version: string,
  mode: "native" | "auto" = "auto",
): Effect.Effect<
  ServiceResolution,
  ChecksumMismatchError | BinaryNotFoundError | DownloadError
> => {
  const nativeBinary = resolver
    .resolve({ service, version })
    .pipe(Effect.map((path): ServiceResolution => ({ type: "binary", path })));
  if (mode === "native") {
    return nativeBinary;
  }
  const dockerFallback = () =>
    Effect.succeed<ServiceResolution>({
      type: "docker",
      image: dockerImageForService(service, version),
    });
  return nativeBinary.pipe(
    Effect.catchTag("BinaryNotFoundError", dockerFallback),
    Effect.catchTag("DownloadError", dockerFallback),
  );
};
