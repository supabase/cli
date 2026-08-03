import type { ServiceName } from "./versions.ts";

type ServiceAccess = "proxy-http" | "proxy-websocket" | "direct" | "companion";

export interface ServiceActivationPolicy {
  /** How a caller reaches the service while the stack is running lazily. */
  readonly access: ServiceAccess;
}

/**
 * Central ownership map for lazy startup. Services with a direct TCP or HTTP
 * endpoint must be running before that endpoint is published. Companion
 * services are activated with the public service that consumes them.
 */
export const SERVICE_ACTIVATION_POLICY: Readonly<Record<ServiceName, ServiceActivationPolicy>> = {
  postgres: { access: "direct" },
  postgrest: { access: "proxy-http" },
  auth: { access: "proxy-http" },
  "edge-runtime": { access: "proxy-http" },
  realtime: { access: "direct" },
  storage: { access: "proxy-http" },
  imgproxy: { access: "companion" },
  mailpit: { access: "direct" },
  pgmeta: { access: "proxy-http" },
  studio: { access: "direct" },
  analytics: { access: "proxy-http" },
  vector: { access: "companion" },
  pooler: { access: "direct" },
};

export const eagerServices = (enabled: ReadonlyArray<ServiceName>): ReadonlyArray<ServiceName> =>
  enabled.filter((service) => SERVICE_ACTIVATION_POLICY[service].access === "direct");

export const activationTargetsForService = (
  enabledServices: ReadonlyArray<ServiceName>,
  service: ServiceName,
): ReadonlyArray<ServiceName> => {
  const enabled = new Set(enabledServices);
  const companions: ReadonlyArray<ServiceName> =
    service === "storage" ? ["imgproxy"] : service === "analytics" ? ["vector"] : [];

  return [service, ...companions].filter((target) => enabled.has(target));
};
