import { PORT_CATALOG, PORT_FIELDS, type PortField } from "./PortCatalog.ts";
import { SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";
import type { StackConfig, StackMode } from "./StackConfig.ts";

const serviceEnabledForConfig = (config: StackConfig, service: keyof typeof SERVICE_CATALOG) => {
  if (config.servicePolicies?.[service] === "off") return false;
  if (service === "postgres" || service === "postgrest" || service === "auth") {
    return config[service === "postgres" ? "postgres" : service] !== false;
  }
  if (service === "edge-runtime") {
    return config.edgeRuntime !== false && (config.edgeRuntime?.enabled ?? true) !== false;
  }
  const configKey = SERVICE_CATALOG[service].configKey;
  if (configKey === "vector") return config.vector !== undefined && config.vector !== false;
  return config[configKey] !== undefined && config[configKey] !== false;
};

/** Classifies active services before any ports are resolved. */
export const portFieldsForConfigInput = (config: StackConfig = {}): ReadonlyArray<PortField> => {
  const mode = config.mode ?? "native";
  return PORT_FIELDS.filter((field) => {
    if (field === "apiPort" || field === "dbPort") return true;
    const service = PORT_CATALOG[field].service;
    if (service === undefined || !serviceEnabledForConfig(config, service)) return false;
    // Native-only listeners (such as Vector's admin API) stay inside Docker
    // containers and therefore must not consume a host lease there.
    return !(PORT_CATALOG[field].nativeOnly === true && mode !== "native");
  });
};

export const portFieldsForService = (name: string, mode: StackMode): ReadonlyArray<PortField> => {
  const service = SERVICE_NAMES.find((candidate) => candidate === name);
  if (service === undefined) return [];
  return SERVICE_CATALOG[service].portFields.filter(
    (field) => !(PORT_CATALOG[field].nativeOnly === true && mode !== "native"),
  );
};
