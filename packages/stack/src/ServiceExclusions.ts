import { SERVICE_NAMES } from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

const excludedCompanions: Readonly<Record<ServiceName, ReadonlyArray<ServiceName>>> = {
  storage: ["imgproxy"],
  pgmeta: ["studio"],
  analytics: ["vector"],
  postgres: [],
  postgrest: [],
  auth: [],
  "edge-runtime": [],
  realtime: [],
  imgproxy: [],
  mailpit: [],
  studio: [],
  vector: [],
  pooler: [],
};

const isServiceName = (value: string): value is ServiceName =>
  SERVICE_NAMES.some((service) => service === value);

/** Expands public exclusions to include services whose graph requires them. */
export const expandExcludedServices = (
  services: ReadonlyArray<string>,
): ReadonlySet<ServiceName> => {
  const expanded = new Set<ServiceName>();
  for (const service of services) {
    if (!isServiceName(service)) continue;
    expanded.add(service);
    for (const companion of excludedCompanions[service]) expanded.add(companion);
  }
  return expanded;
};
