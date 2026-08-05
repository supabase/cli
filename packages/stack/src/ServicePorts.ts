import type { PortField } from "./PortAllocator.ts";
import { enabledServicesForConfig, type ResolvedStackConfig } from "./StackBuilder.ts";
import { SERVICE_NAMES, type ServiceName } from "./versions.ts";

export const allocatedPortFieldsForConfig = (
  config: ResolvedStackConfig,
): ReadonlyArray<PortField> => [
  "apiPort",
  ...enabledServicesForConfig(config).flatMap((service) => SERVICE_PORT_FIELDS[service]),
];

const SERVICE_PORT_FIELDS = {
  postgres: ["dbPort"],
  postgrest: ["postgrestPort", "postgrestAdminPort"],
  auth: ["authPort"],
  "edge-runtime": ["edgeRuntimePort", "edgeRuntimeInspectorPort"],
  realtime: ["realtimePort"],
  storage: ["storagePort"],
  imgproxy: ["imgproxyPort"],
  mailpit: ["mailpitPort", "mailpitSmtpPort", "mailpitPop3Port"],
  pgmeta: ["pgmetaPort"],
  studio: ["studioPort"],
  analytics: ["analyticsPort"],
  vector: [],
  pooler: ["poolerPort", "poolerApiPort"],
} as const satisfies Readonly<Record<ServiceName, ReadonlyArray<PortField>>>;

export const portFieldsForService = (name: string): ReadonlyArray<PortField> => {
  const service = SERVICE_NAMES.find((candidate) => candidate === name);
  return service === undefined ? [] : SERVICE_PORT_FIELDS[service];
};
