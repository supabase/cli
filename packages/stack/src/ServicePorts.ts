import { PORT_CATALOG, PORT_FIELDS, type PortField } from "./PortCatalog.ts";
import { SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";
import type { StackConfig } from "./StackConfig.ts";

const serviceEnabledForConfig = (config: StackConfig, service: keyof typeof SERVICE_CATALOG) => {
  if (config.servicePolicies?.[service] === "off") return false;
  if (service === "postgres" || service === "postgrest" || service === "auth") {
    return config[service === "postgres" ? "postgres" : service] !== false;
  }
  if (service === "edge-runtime") {
    const mode = config.mode ?? "native";
    return (
      !(mode === "native" && config.edgeRuntime === undefined) &&
      config.edgeRuntime !== false &&
      (config.edgeRuntime?.enabled ?? true) !== false
    );
  }
  const configKey = SERVICE_CATALOG[service].configKey;
  if (configKey === "vector") return config.vector !== undefined && config.vector !== false;
  return config[configKey] !== undefined && config[configKey] !== false;
};

/** Classifies active services before any ports are resolved. */
export const portFieldsForConfigInput = (config: StackConfig = {}): ReadonlyArray<PortField> =>
  PORT_FIELDS.filter(
    (field) =>
      field === "apiPort" ||
      field === "dbPort" ||
      (PORT_CATALOG[field].service !== undefined &&
        serviceEnabledForConfig(config, PORT_CATALOG[field].service)),
  );

export const portFieldsForService = (name: string): ReadonlyArray<PortField> => {
  const service = SERVICE_NAMES.find((candidate) => candidate === name);
  return service === undefined ? [] : SERVICE_CATALOG[service].portFields;
};
