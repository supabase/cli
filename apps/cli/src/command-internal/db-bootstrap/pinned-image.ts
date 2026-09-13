import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import { slimImageForCurrentPin } from "../../shared/services/slim-images.ts";
import type {
  LocalServiceVersionName,
  LocalServiceVersionOverrides,
} from "../../shared/services/services.shared.ts";

/**
 * Resolves the image for `alias`, replacing its tag with `serviceVersions`' pin for
 * `localServiceName` when one is present.
 *
 * Only the current Dockerfile pin is slim-translated; a historical `.temp` pin stays on
 * docker.io since those slim tags aren't published.
 */
export function resolvePinnedImage(
  alias: string,
  localServiceName: LocalServiceVersionName,
  serviceVersions: LocalServiceVersionOverrides,
): string {
  return slimImageForCurrentPin(
    alias,
    dockerfileServiceImageRaw(alias),
    serviceVersions[localServiceName],
  );
}
