import { ServiceNotFoundError } from "@supabase/process-compose";
import type { ServiceReadyError } from "@supabase/process-compose";
import { Context, Effect, Layer } from "effect";
import { StackBuildError, StackNotRunningError, StackReadinessError } from "./errors.ts";
import { stackServiceStartupBudgetSeconds } from "./services/health-budgets.ts";
import { SERVICE_NAMES, serviceMetadata } from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

export const eagerServices = (enabled: ReadonlyArray<ServiceName>): ReadonlyArray<ServiceName> =>
  enabled.filter((service) => serviceMetadata(service).activation.startup === "eager");

export const activationTargetsForService = (
  enabledServices: ReadonlyArray<ServiceName>,
  service: ServiceName,
): ReadonlyArray<ServiceName> => {
  const enabled = new Set(enabledServices);
  const targets = new Set<ServiceName>();
  const addWithCompanions = (target: ServiceName): void => {
    if (!enabled.has(target) || targets.has(target)) return;
    for (const activated of serviceMetadata(target).activation.activates) {
      addWithCompanions(activated);
    }
    targets.add(target);
  };
  addWithCompanions(service);

  return [...targets];
};

const DEFAULT_ACTIVATION_TIMEOUT_FLOOR_SECONDS = 180;
const ACTIVATION_COORDINATION_MARGIN_SECONDS = 5;

/**
 * Bounds request-triggered lazy activation by the complete companion closure.
 * The floor preserves the existing tolerance for services with shorter probe
 * budgets, while longer transitive closures expand the timeout automatically.
 */
export const activationTimeoutSecondsForService = (service: ServiceName): number => {
  const startupBudget = activationTargetsForService(SERVICE_NAMES, service).reduce(
    (total, target) => total + stackServiceStartupBudgetSeconds[target],
    0,
  );
  return Math.max(
    DEFAULT_ACTIVATION_TIMEOUT_FLOOR_SECONDS,
    startupBudget + ACTIVATION_COORDINATION_MARGIN_SECONDS,
  );
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
    for (const owned of serviceMetadata(target).activation.owns) {
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
      | ServiceNotFoundError
      | ServiceReadyError
      | StackBuildError
      | StackNotRunningError
      | StackReadinessError
    >;
  }
>()("stack/StackServiceActivator") {
  static noop = Layer.succeed(this, {
    activate: () => Effect.void,
  });
}
