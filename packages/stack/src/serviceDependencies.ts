import type { ServiceName } from "./versions.ts";

export const validateEnabledServiceDependencies = (
  enabledServices: ReadonlySet<ServiceName>,
): string | undefined => {
  if (enabledServices.has("imgproxy") && !enabledServices.has("storage")) {
    return "imgproxy requires storage to be enabled";
  }

  if (enabledServices.has("vector") && !enabledServices.has("analytics")) {
    return "vector requires analytics to be enabled";
  }

  if (enabledServices.has("studio") && !enabledServices.has("pgmeta")) {
    return "studio requires pgmeta to be enabled";
  }

  return undefined;
};
