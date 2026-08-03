import { ServiceNotFoundError } from "@supabase/process-compose";
import type { ServiceReadyError } from "@supabase/process-compose";
import { Context, Effect, Layer } from "effect";
import { StackBuildError, StackNotRunningError } from "./errors.ts";
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
  const targets = new Set<ServiceName>();
  const addWithCompanions = (target: ServiceName): void => {
    if (!enabled.has(target) || targets.has(target)) return;
    targets.add(target);
    if (target === "storage") addWithCompanions("imgproxy");
    if (target === "analytics") addWithCompanions("vector");
    if (target === "studio") addWithCompanions("analytics");
  };
  addWithCompanions(service);

  return [...targets];
};

/** Services exclusively owned by a public service for stop/restart operations. */
export const lifecycleTargetsForService = (
  enabledServices: ReadonlyArray<ServiceName>,
  service: ServiceName,
): ReadonlyArray<ServiceName> => {
  const enabled = new Set(enabledServices);
  const targets: ServiceName[] = [];
  const add = (target: ServiceName): void => {
    if (enabled.has(target)) targets.push(target);
  };

  add(service);
  if (service === "storage") add("imgproxy");
  if (service === "analytics") add("vector");
  return targets;
};

export class StackServiceActivator extends Context.Service<
  StackServiceActivator,
  {
    readonly activate: (
      service: ServiceName,
    ) => Effect.Effect<
      void,
      ServiceNotFoundError | ServiceReadyError | StackBuildError | StackNotRunningError
    >;
  }
>()("stack/StackServiceActivator") {
  static noop = Layer.succeed(this, {
    activate: () => Effect.void,
  });
}
