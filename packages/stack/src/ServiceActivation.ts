import { ServiceNotFoundError } from "@supabase/process-compose";
import type { ServiceReadyError } from "@supabase/process-compose";
import { Context, Effect, Layer } from "effect";
import { StackBuildError, StackNotRunningError, StackReadinessError } from "./errors.ts";
import { serviceMetadata } from "./ServiceCatalog.ts";
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
