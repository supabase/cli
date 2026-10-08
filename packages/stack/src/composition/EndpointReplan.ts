import { Effect, Schema } from "effect";
import type { makePorts } from "../Ports.ts";
import type { EndpointPortChange } from "../Rpc.ts";
import { ServiceCreation, type ServiceCreationInput } from "../services/Catalog.ts";
import type * as StackNamespace from "../StackNamespace.ts";
import { planEndpointReplan } from "./Supabase.ts";

type Ports = Effect.Success<ReturnType<typeof makePorts>>;

/** A changed endpoint's registry key and the port it held before the change, when known. */
interface ChangedEndpoint {
  readonly key: string;
  readonly service: string;
  readonly endpoint: string;
  readonly from: number | undefined;
}

/** The saved document a stopped stack's owner starts from, once its changed endpoints are re-planned. */
interface EndpointReplan {
  readonly saved: StackNamespace.SavedStack;
  /** The instances whose endpoints changed, for the owner to claim from `saved`. */
  readonly changedInstanceIds: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<ChangedEndpoint>;
}

/**
 * Saves `requested`'s endpoint intents over a stopped stack's and releases the changed endpoints'
 * registry rows, so the owner's normal endpoint binding claims the new ports. The saved intent
 * stays as requested if that claim then fails. Returns `undefined` when no endpoint changed.
 */
export const applyEndpointReplan = Effect.fn("EndpointReplan.apply")(function* (
  state: StackNamespace.Interface,
  ports: Ports,
  saved: StackNamespace.SavedStack,
  requested: ReadonlyArray<ServiceCreationInput>,
) {
  const plan = planEndpointReplan(saved, requested);
  if (plan === undefined || (plan.changes.length === 0 && !plan.releasesSharedApi))
    return undefined;

  const changed = yield* Effect.forEach(plan.changes, (change) =>
    ports.assigned(saved.id, change.key).pipe(
      Effect.map((assigned): ChangedEndpoint => ({
        key: change.key,
        service: change.service,
        endpoint: change.endpoint,
        from: assigned ?? (change.previous === "auto" ? undefined : change.previous),
      })),
    ),
  );
  const instances = yield* Effect.forEach(saved.instances, (instance) => {
    const endpoints = plan.endpointsByInstance.get(instance.id);
    return endpoints === undefined
      ? Effect.succeed(instance)
      : Schema.decodeUnknownEffect(ServiceCreation)({ ...instance.creation, endpoints }).pipe(
          Effect.map((creation) => ({ ...instance, creation })),
        );
  });
  const replanned = { ...saved, instances };

  // Release before saving: a failure between the two leaves the old intent and no row, which
  // the next start re-plans again, never a new intent that an old row contradicts.
  const releasedKeys = new Set([
    ...plan.changes.map((change) => change.key),
    ...(plan.releasesSharedApi ? ["api"] : []),
  ]);
  yield* Effect.forEach(releasedKeys, (key) => ports.release(saved.id, key), { discard: true });
  if (plan.changes.length > 0) yield* state.withLock(state.save(replanned));
  yield* Effect.annotateCurrentSpan({ "stack.endpoint_changes": changed.length });

  return {
    saved: replanned,
    changedInstanceIds: [...new Set(plan.changes.map((change) => change.id))],
    changed,
  } satisfies EndpointReplan;
});

/** The changed endpoints whose claimed port differs from the one they held before. */
export const reportedEndpointChanges = Effect.fn("EndpointReplan.report")(function* (
  ports: Ports,
  stackId: string,
  changed: ReadonlyArray<ChangedEndpoint>,
) {
  const reported: Array<EndpointPortChange> = [];
  for (const change of changed) {
    const to = yield* ports.assigned(stackId, change.key);
    if (change.from !== undefined && to !== undefined && change.from !== to)
      reported.push({
        service: change.service,
        endpoint: change.endpoint,
        from: change.from,
        to,
      });
  }
  return reported;
});
