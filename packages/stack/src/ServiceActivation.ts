import { ServiceNotFoundError } from "@supabase/process-compose";
import type { ServiceReadyError } from "@supabase/process-compose";
import { Context, Effect, Layer } from "effect";
import { StackBuildError, StackNotRunningError } from "./errors.ts";
import type { ServiceName } from "./versions.ts";

export interface ServiceActivationPolicy {
  /** Whether the public service must already be running when lazy startup completes. */
  readonly startup: "eager" | "lazy";
  /** Other public services required when this service is activated. */
  readonly activates?: ReadonlyArray<ServiceName>;
  /** Private companions whose lifecycle is exclusively owned by this service. */
  readonly owns?: ReadonlyArray<ServiceName>;
}

/**
 * Central ownership map for lazy startup. Services with a direct TCP or HTTP
 * endpoint must be running before that endpoint is published. Companion
 * services are activated with the public service that consumes them.
 */
export const SERVICE_ACTIVATION_POLICY: Readonly<Record<ServiceName, ServiceActivationPolicy>> = {
  postgres: { startup: "eager" },
  postgrest: { startup: "lazy" },
  auth: { startup: "lazy" },
  "edge-runtime": { startup: "lazy" },
  realtime: { startup: "eager" },
  storage: { startup: "lazy", activates: ["imgproxy"], owns: ["imgproxy"] },
  imgproxy: { startup: "lazy" },
  mailpit: { startup: "eager" },
  pgmeta: { startup: "lazy" },
  studio: { startup: "eager", activates: ["analytics"] },
  analytics: { startup: "lazy", activates: ["vector"], owns: ["vector"] },
  vector: { startup: "lazy" },
  pooler: { startup: "eager" },
};

export const eagerServices = (enabled: ReadonlyArray<ServiceName>): ReadonlyArray<ServiceName> =>
  enabled.filter((service) => SERVICE_ACTIVATION_POLICY[service].startup === "eager");

export const activationTargetsForService = (
  enabledServices: ReadonlyArray<ServiceName>,
  service: ServiceName,
): ReadonlyArray<ServiceName> => {
  const enabled = new Set(enabledServices);
  const targets = new Set<ServiceName>();
  const addWithCompanions = (target: ServiceName): void => {
    if (!enabled.has(target) || targets.has(target)) return;
    for (const activated of SERVICE_ACTIVATION_POLICY[target].activates ?? []) {
      addWithCompanions(activated);
    }
    targets.add(target);
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

  const addWithOwnedCompanions = (target: ServiceName): void => {
    add(target);
    for (const owned of SERVICE_ACTIVATION_POLICY[target].owns ?? []) {
      addWithOwnedCompanions(owned);
    }
  };
  addWithOwnedCompanions(service);
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
