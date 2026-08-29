import { Data, Deferred, Effect, Exit, FiberSet, Semaphore } from "effect";
import { GatewayActivationError } from "../public/Errors.ts";
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { PortField } from "../public/Status.ts";
import { makeHttpGateway, type HttpGateway, type HttpGatewayOptions } from "./HttpGateway.ts";
import { makeTcpGateway, type TcpGateway, type TcpGatewayOptions } from "./TcpGateway.ts";

/** A private backend endpoint returned only after activation has completed. */
export interface BackendEndpoint {
  readonly host: string;
  readonly port: number;
}

export interface ActivationResult {
  readonly capability: CapabilityName;
  readonly endpoint: BackendEndpoint;
}

export interface ActivationTarget {
  readonly dependencies: ReadonlyArray<CapabilityName>;
}

/** Internal route preflight failure used for request-time discovery. */
export class GatewayRouteNotFoundError extends Data.TaggedError("GatewayRouteNotFoundError")<{
  readonly message: string;
}> {}

export interface PreparedGatewayRoute {
  readonly resolveBackend: (
    activation: ActivationResult,
  ) => Effect.Effect<BackendEndpoint, GatewayActivationError>;
  /** Optional request path sent to the activated backend. */
  readonly upstreamPath?: (request: GatewayRouteRequest) => string;
  /** Optional header transform applied after hop-by-hop filtering. */
  readonly upstreamHeaders?: GatewayHeaderTransform;
}

export interface LazyActivator {
  /** Activates a capability and all of its dependencies once for a generation. */
  readonly activate: (
    capability: CapabilityName,
  ) => Effect.Effect<ActivationResult, GatewayActivationError>;
  readonly generation: number;
}

export interface LazyActivatorOptions {
  readonly generation: number;
  readonly targets: Readonly<Partial<Record<CapabilityName, ActivationTarget>>>;
  readonly activate: (
    capability: CapabilityName,
  ) => Effect.Effect<ActivationResult, GatewayActivationError>;
}

const activationError = (message: string): GatewayActivationError =>
  new GatewayActivationError({ message });

/**
 * Build a Supervisor-local one-way activation coordinator. A per-capability
 * semaphore joins concurrent requests to one dependency/start operation;
 * successful activations are retained until the owner scope ends, while a
 * failed operation can be retried under the Supervisor restart policy.
 */
export const createLazyActivator = (
  options: LazyActivatorOptions,
): Effect.Effect<LazyActivator, GatewayActivationError, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    interface ActivationState {
      result?: ActivationResult;
      flight?: Deferred.Deferred<ActivationResult, GatewayActivationError>;
      readonly lock: Semaphore.Semaphore;
    }
    // Activation fibers belong to the Supervisor owner scope, not to an
    // individual gateway request. This keeps a cancelled waiter from
    // interrupting the shared start operation while still interrupting all
    // starts when the owner scope closes.
    const runFork = yield* FiberSet.makeRuntime<never, unknown, unknown>();
    const states = new Map<CapabilityName, ActivationState>();
    const visiting = new Set<CapabilityName>();
    const visited = new Set<CapabilityName>();
    const visit = (capability: CapabilityName): boolean => {
      if (visiting.has(capability)) return false;
      if (visited.has(capability)) return true;
      const target = options.targets[capability];
      if (target === undefined) return false;
      visiting.add(capability);
      const valid = target.dependencies.every(visit);
      visiting.delete(capability);
      if (!valid) return false;
      visited.add(capability);
      return true;
    };
    for (const name of CAPABILITY_NAMES) {
      if (options.targets[name] !== undefined && !visit(name))
        return yield* activationError("Capability dependency graph is invalid");
    }
    const activate = (
      capability: CapabilityName,
    ): Effect.Effect<ActivationResult, GatewayActivationError> => {
      const target = options.targets[capability];
      if (target === undefined)
        return Effect.fail(activationError("Requested capability is not enabled"));
      const state = states.get(capability);
      if (state === undefined)
        return Effect.fail(activationError("Requested capability is not enabled"));
      const execute = Effect.forEach(target.dependencies, activate, {
        concurrency: "unbounded",
      }).pipe(Effect.andThen(options.activate(capability)));
      return Effect.gen(function* () {
        const decision = yield* state.lock.withPermit(
          Effect.sync(() => {
            if (state.result !== undefined) return { _tag: "done" as const, result: state.result };
            if (state.flight !== undefined)
              return { _tag: "join" as const, deferred: state.flight };
            const deferred = Deferred.makeUnsafe<ActivationResult, GatewayActivationError>();
            state.flight = deferred;
            // This fiber is registered in the owner FiberSet and therefore is
            // independent from the request fibers awaiting its Deferred.
            runFork(
              Effect.uninterruptibleMask((restore) =>
                Effect.exit(restore(execute)).pipe(
                  Effect.flatMap((exit) =>
                    state.lock.withPermit(
                      Effect.sync(() => {
                        if (Exit.isSuccess(exit)) state.result = exit.value;
                        state.flight = undefined;
                        Deferred.doneUnsafe(deferred, exit);
                      }),
                    ),
                  ),
                ),
              ),
            );
            return { _tag: "join" as const, deferred };
          }),
        );
        return decision._tag === "done"
          ? decision.result
          : yield* Deferred.await(decision.deferred);
      });
    };

    // Install every cached effect before returning the service. This avoids a
    // race where two callers can both create the first flight for a target.
    for (const name of CAPABILITY_NAMES)
      if (options.targets[name] !== undefined) states.set(name, { lock: yield* Semaphore.make(1) });

    return { generation: options.generation, activate } satisfies LazyActivator;
  });

export interface GatewayRouteRequest {
  readonly path: string;
  readonly method?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type GatewayHeaderValue = string | string[];
export type GatewayHeaders = Readonly<Record<string, GatewayHeaderValue>>;
export type GatewayHeaderTransform = (
  request: GatewayRouteRequest,
  headers: GatewayHeaders,
) => GatewayHeaders;

export interface GatewayRoute {
  readonly capability: CapabilityName;
  /** Workload binding selected when a capability exposes multiple endpoints. */
  readonly binding?: string;
  readonly match: (request: GatewayRouteRequest) => boolean;
  /** Optional path transform applied before proxying when no prepared route overrides it. */
  readonly upstreamPath?: (request: GatewayRouteRequest) => string;
  /** Optional header transform applied after hop-by-hop filtering. */
  readonly upstreamHeaders?: GatewayHeaderTransform;
  /** Request-time validation and preparation performed before activation. */
  readonly prepare?: (
    request: GatewayRouteRequest,
  ) => Effect.Effect<PreparedGatewayRoute, GatewayRouteNotFoundError | GatewayActivationError>;
}

export interface StackGateway {
  readonly http: ReadonlyMap<PortField, HttpGateway>;
  readonly tcp: ReadonlyMap<PortField, TcpGateway>;
  readonly close: Effect.Effect<void>;
}

export interface HttpGatewayListenerOptions {
  readonly field: PortField;
  readonly options: Omit<HttpGatewayOptions, "activate">;
}

export interface TcpGatewayListenerOptions {
  readonly field: PortField;
  readonly options: Omit<TcpGatewayOptions, "activate">;
}

export interface StackGatewayOptions {
  readonly http?: ReadonlyArray<HttpGatewayListenerOptions>;
  readonly tcp?: ReadonlyArray<TcpGatewayListenerOptions>;
  readonly activate: LazyActivator["activate"];
}

/** Compose the protocol gateways under one Supervisor-owned lifecycle scope. */
export const makeGateway = (
  options: StackGatewayOptions,
): Effect.Effect<StackGateway, GatewayActivationError, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const http = new Map<PortField, HttpGateway>();
    const tcp = new Map<PortField, TcpGateway>();
    const closeValues = (values: Iterable<{ readonly close: Effect.Effect<void> }>) =>
      Effect.forEach(values, (gateway) => gateway.close.pipe(Effect.exit), {
        concurrency: "unbounded",
        discard: true,
      });
    for (const entry of options.http ?? []) {
      if (http.has(entry.field)) {
        yield* closeValues(http.values());
        return yield* new GatewayActivationError({
          message: `Duplicate HTTP gateway listener ${entry.field}`,
        });
      }
      const acquired = yield* Effect.exit(
        makeHttpGateway({ ...entry.options, activate: options.activate }),
      );
      if (Exit.isFailure(acquired)) {
        yield* closeValues(http.values());
        return yield* Effect.failCause(acquired.cause);
      }
      http.set(entry.field, acquired.value);
    }
    for (const entry of options.tcp ?? []) {
      if (tcp.has(entry.field) || http.has(entry.field)) {
        yield* closeValues([...http.values(), ...tcp.values()]);
        return yield* new GatewayActivationError({
          message: `Duplicate gateway listener ${entry.field}`,
        });
      }
      const acquired = yield* Effect.exit(
        makeTcpGateway({ ...entry.options, activate: options.activate }),
      );
      if (Exit.isFailure(acquired)) {
        yield* closeValues([...http.values(), ...tcp.values()]);
        return yield* Effect.failCause(acquired.cause);
      }
      tcp.set(entry.field, acquired.value);
    }
    const closeOperation = closeValues([...http.values(), ...tcp.values()]);
    const close = yield* Effect.cached(closeOperation);
    return { http, tcp, close } satisfies StackGateway;
  });
