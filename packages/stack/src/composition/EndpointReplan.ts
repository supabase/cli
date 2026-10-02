import { Effect, Schema } from "effect";
import { claimantOf } from "../Ports.ts";
import type { EndpointPortChange } from "../Rpc.ts";
import { ServiceCreation, type ServiceCreationInput } from "../services/Catalog.ts";
import type * as State from "../State.ts";
import { planEndpointReplan } from "./Supabase.ts";

/** One changed endpoint's claim key and its port before the change, for reporting and restore. */
export interface ChangedEndpointKey {
  readonly key: string;
  readonly service: string;
  readonly endpoint: string;
  readonly previousPort: number | undefined;
}

interface EndpointReplanPreparation {
  /** The document to register the owner from: new endpoint intents, changed claims dropped. */
  readonly saved: State.SavedStack;
  /** The instances whose endpoints changed, to claim once the owner is built from `saved`. */
  readonly changedInstanceIds: ReadonlyArray<string>;
  readonly changedKeys: ReadonlyArray<ChangedEndpointKey>;
}

/**
 * Computes the saved document a stopped stack's owner registers from: endpoint intents updated to
 * `requested`, and the changed endpoints' old port claims dropped. The owner's normal endpoint
 * binding then claims them, reusing every check a live composition bind already applies; nothing
 * here claims a port itself. Returns `undefined` when nothing changed.
 */
export const prepareEndpointReplan = Effect.fn("EndpointReplan.prepare")(function* (
  saved: State.SavedStack,
  requested: ReadonlyArray<ServiceCreationInput>,
) {
  const plan = planEndpointReplan(saved, requested);
  if (plan === undefined || plan.changes.length === 0) return undefined;

  const touchedKeys = new Set(plan.changes.map((change) => change.key));
  const instances = yield* Effect.forEach(saved.instances, (instance) => {
    const endpoints = plan.endpointsByInstance.get(instance.id);
    return endpoints === undefined
      ? Effect.succeed(instance)
      : Schema.decodeUnknownEffect(ServiceCreation)({ ...instance.creation, endpoints }).pipe(
          Effect.map((creation) => ({ ...instance, creation })),
        );
  });

  const preparation: EndpointReplanPreparation = {
    saved: {
      ...saved,
      instances,
      ports: saved.ports.filter((claim) => !touchedKeys.has(claim.key)),
    },
    changedInstanceIds: [...new Set(plan.changes.map((change) => change.id))],
    changedKeys: plan.changes.map((change) => ({
      key: change.key,
      service: change.service,
      endpoint: change.endpoint,
      previousPort: change.previousPort,
    })),
  };
  return preparation;
});

/**
 * Restores the document read before a failed re-plan, dropping only a touched key whose old port
 * another stack has since claimed; that key is left unclaimed, so the next start reports it as a
 * normal port conflict instead of overlapping the other stack's claim. The read of other stacks'
 * claims, the filtering, and the save run inside one lock, so a concurrent claim on the same port
 * is either already visible here or still waiting for this lock, never both unseen and applied.
 */
export const restoreFailedEndpointReplan = Effect.fn("EndpointReplan.restore")(function* (
  state: State.Interface,
  registered: State.SavedStack,
  changedKeys: ReadonlyArray<Pick<ChangedEndpointKey, "key">>,
) {
  const touchedKeys = new Set(changedKeys.map((change) => change.key));
  yield* state.withLock(
    Effect.gen(function* () {
      const others = yield* state.claims;
      const ports = registered.ports.filter(
        (claim) =>
          !touchedKeys.has(claim.key) ||
          claimantOf(others, registered.id, claim.port) === undefined,
      );
      yield* state.save({ ...registered, ports });
    }),
  );
});

/**
 * The changed keys whose newly claimed port differs from its saved value, as reportable endpoint
 * changes. An automatic re-plan that resolved back to its previous port is left out: persisting
 * the updated intent still matters, but it is not a change worth reporting.
 */
export const reportedEndpointChanges = (
  changedKeys: ReadonlyArray<ChangedEndpointKey>,
  after: State.SavedStack | undefined,
): ReadonlyArray<EndpointPortChange> =>
  changedKeys.flatMap((change) => {
    const to = after?.ports.find((claim) => claim.key === change.key)?.port;
    return change.previousPort === undefined || to === undefined || change.previousPort === to
      ? []
      : [{ service: change.service, endpoint: change.endpoint, from: change.previousPort, to }];
  });
