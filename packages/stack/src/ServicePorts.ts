import type { PortField } from "./PortAllocator.ts";
import { enabledServicesForConfig } from "./StackBuilder.ts";
import { SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";
import type { ResolvedStackConfig } from "./StackConfig.ts";

export const allocatedPortFieldsForConfig = (
  config: ResolvedStackConfig,
): ReadonlyArray<PortField> => [
  "apiPort",
  ...enabledServicesForConfig(config).flatMap((service) => SERVICE_CATALOG[service].portFields),
];

export const portFieldsForService = (name: string): ReadonlyArray<PortField> => {
  const service = SERVICE_NAMES.find((candidate) => candidate === name);
  return service === undefined ? [] : SERVICE_CATALOG[service].portFields;
};
