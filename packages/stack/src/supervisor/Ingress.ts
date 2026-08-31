import { Context, Crypto, Effect, FileSystem, Path, Ref, Scope, Semaphore } from "effect";
import type { LifecycleInput } from "./Lifecycle.ts";
import type {
  ActivationResult,
  GatewayRoute,
  GatewayProxyRoute,
  GatewayRouteRequest,
  StackGateway,
} from "../gateway/Gateway.ts";
import {
  GatewayActivationError,
  StackPreparationError,
  type StackError,
} from "../public/Errors.ts";
import { routeCatalogFor, type GatewayApiMaterial } from "../gateway/RouteCatalog.ts";
import { GatewayRouteNotFoundError, makeGateway } from "../gateway/Gateway.ts";
import {
  makePortCoordinator,
  type HostListener,
  type ListenerIntents,
  type PortCoordinator,
  type PortReservation,
} from "../state/PortCoordinator.ts";
import type { PortRegistry } from "../state/PortRegistry.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { privateBindingIntentsFor } from "../runtime/WorkloadRuntimeSpec.ts";
import type { PortField } from "../public/Status.ts";
import { bindHostListener, isHttpPortField } from "./HostListener.ts";

export interface SupervisorIngressReservation extends PortReservation {
  readonly generation: number;
  /** False when this generation already owns the exact listeners and gateway. */
  readonly fresh: boolean;
}

export interface SupervisorIngress {
  /** Reserve durable ports and bind public listeners before workload reconciliation. */
  readonly acquire: (
    input: LifecycleInput,
  ) => Effect.Effect<SupervisorIngressReservation, StackError>;
  /** Adopt acquired listeners into HTTP/TCP gateways after workloads are ready. */
  readonly open: (
    input: LifecycleInput,
    reservation: SupervisorIngressReservation,
    activate: (
      capability: import("../public/Capability.ts").CapabilityName,
    ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>,
  ) => Effect.Effect<void, GatewayActivationError | StackError>;
  /** Close gateway, accepted sockets, and exact listeners; safe to call repeatedly. */
  readonly close: Effect.Effect<void, StackError>;
}

export interface SupervisorIngressOptions {
  readonly stackId: string;
  readonly registry: PortRegistry;
  readonly store: StackStateStore;
  readonly portCoordinator?: PortCoordinator;
  readonly context: Context.Context<Crypto.Crypto | FileSystem.FileSystem | Path.Path>;
  /** Resolver may be replaced by the production credential owner. */
  readonly apiMaterial?: (
    state: LifecycleInput["state"],
  ) => Effect.Effect<GatewayApiMaterial, StackPreparationError>;
  /** Resolves the accepted generation's Auth templates for live local serving. */
  readonly resolveAuthTemplates?: (state: LifecycleInput["state"]) => Effect.Effect<
    ReadonlyArray<{
      readonly id: string;
      readonly canonicalPath: string;
      readonly extension: string;
    }>,
    StackPreparationError
  >;
  readonly bindHost?: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<HostListener, import("../public/Errors.ts").PortUnavailableError, Scope.Scope>;
}

const listenerIntents = (input: LifecycleInput): ListenerIntents => ({
  api: input.definition.listeners.api,
  database: input.definition.listeners.database,
  pooler: input.definition.listeners.pooler,
  studio: input.definition.listeners.studio,
  mailUi: input.definition.listeners.mailUi,
  smtp: input.definition.listeners.smtp,
  pop3: input.definition.listeners.pop3,
  functionsInspector: input.definition.listeners.functionsInspector,
});

const defaultApiMaterial = (
  state: LifecycleInput["state"],
): Effect.Effect<GatewayApiMaterial, StackPreparationError> => {
  const get = (slot: string): string | undefined => state.secrets[slot]?.value;
  const publishableKey = get("secret:auth.settings.publishable_key");
  const secretKey = get("secret:auth.settings.secret_key");
  const anonJwt = get("secret:auth.settings.anon_key");
  const serviceRoleJwt = get("secret:auth.settings.service_role_key");
  if (
    publishableKey === undefined ||
    secretKey === undefined ||
    anonJwt === undefined ||
    serviceRoleJwt === undefined
  )
    return Effect.fail(
      new StackPreparationError({ message: "Persisted API gateway material is incomplete" }),
    );
  return Effect.succeed({ publishableKey, secretKey, anonJwt, serviceRoleJwt });
};

const routeBackend = (
  input: LifecycleInput,
  reservation: SupervisorIngressReservation,
  route: Pick<GatewayProxyRoute, "capability" | "binding">,
  activation: ActivationResult,
) => {
  if (route.binding === undefined) return Effect.succeed(activation.endpoint);
  const workload = input.plan.workloads.find((entry) => entry.capability === route.capability);
  const assignment = reservation.privateAssignments.find(
    (entry) => entry.workloadId === workload?.id && entry.binding === route.binding,
  );
  return assignment === undefined
    ? Effect.fail(new GatewayActivationError({ message: "Gateway private binding is unavailable" }))
    : Effect.succeed({ host: "127.0.0.1", port: assignment.port });
};

const templateContentType = (extension: string): string => {
  switch (extension.toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
};

/** Compose PortCoordinator and StackGateway under one Supervisor owner scope. */
export const makeSupervisorIngress = (
  options: SupervisorIngressOptions,
): Effect.Effect<
  SupervisorIngress,
  StackError,
  Scope.Scope | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ownerScope = yield* Scope.Scope;
    const lock = yield* Semaphore.make(1);
    const current = yield* Ref.make<
      | {
          readonly input: LifecycleInput;
          readonly reservation: SupervisorIngressReservation;
          readonly gateway?: StackGateway;
        }
      | undefined
    >(undefined);
    const coordinator =
      options.portCoordinator ??
      makePortCoordinator(options.registry, options.store, {
        bindHost: options.bindHost ?? bindHostListener,
      });
    const acquire = (
      input: LifecycleInput,
    ): Effect.Effect<SupervisorIngressReservation, StackError> =>
      lock.withPermit(
        Effect.gen(function* () {
          const existing = yield* Ref.get(current);
          if (existing !== undefined && existing.reservation.generation === input.generation)
            return { ...existing.reservation, fresh: false };
          if (existing !== undefined) yield* closeCurrent(existing);
          const reservation = yield* coordinator
            .planAndReserve(options.stackId, listenerIntents(input), {
              lifecycle: "running",
              expectedGeneration: input.generation,
              nextGeneration: input.generation,
              privateBindings: privateBindingIntentsFor(input.plan),
            })
            .pipe(
              Effect.provideContext(options.context),
              Effect.provideService(Scope.Scope, ownerScope),
            );
          const owned: SupervisorIngressReservation = {
            ...reservation,
            generation: input.generation,
            fresh: true,
          };
          yield* Ref.set(current, { input, reservation: owned });
          return owned;
        }),
      );

    const closeCurrent = (entry: {
      readonly reservation: SupervisorIngressReservation;
      readonly gateway?: StackGateway;
    }): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        if (entry.gateway !== undefined) yield* entry.gateway.close;
        yield* Effect.forEach(entry.reservation.hostListeners, (listener) => listener.close, {
          concurrency: "unbounded",
          discard: true,
        });
      });

    const close: Effect.Effect<void, StackError> = lock.withPermit(
      Effect.gen(function* () {
        const entry = yield* Ref.get(current);
        if (entry === undefined) return;
        yield* closeCurrent(entry);
        yield* Ref.set(current, undefined);
      }),
    );

    const open = (
      input: LifecycleInput,
      reservation: SupervisorIngressReservation,
      activate: (
        capability: import("../public/Capability.ts").CapabilityName,
      ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>,
    ): Effect.Effect<void, GatewayActivationError | StackError> =>
      lock.withPermit(
        Effect.gen(function* () {
          const entry = yield* Ref.get(current);
          if (
            entry !== undefined &&
            entry.reservation.generation === reservation.generation &&
            entry.gateway !== undefined
          )
            return;
          const material = yield* (options.apiMaterial ?? defaultApiMaterial)(input.state);
          const catalog = routeCatalogFor(input.plan, material);
          const resolveTemplates = options.resolveAuthTemplates;
          const templateRoute: GatewayRoute | undefined =
            resolveTemplates === undefined
              ? undefined
              : {
                  match: (request) => {
                    const pathname = request.path.split("?", 1)[0] ?? request.path;
                    return pathname === "/email" || pathname.startsWith("/email/");
                  },
                  localResponse: (request) => {
                    const pathname = request.path.split("?", 1)[0] ?? request.path;
                    if (request.method !== "GET")
                      return Effect.fail(
                        new GatewayRouteNotFoundError({ message: "Auth template not found" }),
                      );
                    return resolveTemplates(input.state).pipe(
                      Effect.mapError(
                        () => new GatewayRouteNotFoundError({ message: "Auth template not found" }),
                      ),
                      Effect.flatMap((templates) => {
                        const template = templates.find(
                          (entry) => `/email/${entry.id}${entry.extension}` === pathname,
                        );
                        return template === undefined
                          ? Effect.fail(
                              new GatewayRouteNotFoundError({
                                message: "Auth template not found",
                              }),
                            )
                          : fs.readFile(template.canonicalPath).pipe(
                              Effect.mapError(
                                () =>
                                  new GatewayRouteNotFoundError({
                                    message: "Auth template not found",
                                  }),
                              ),
                              Effect.map((body) => ({
                                body,
                                contentType: templateContentType(template.extension),
                              })),
                            );
                      }),
                    );
                  },
                };
          const http = reservation.hostListeners
            .filter((listener) => isHttpPortField(listener.field))
            .map((listener) => ({
              field: listener.field,
              options: {
                listener,
                routes:
                  listener.field === "api" && templateRoute !== undefined
                    ? [templateRoute, ...(catalog.http.get(listener.field) ?? [])]
                    : (catalog.http.get(listener.field) ?? []),
                resolveBackend: (
                  route: GatewayProxyRoute,
                  _request: GatewayRouteRequest,
                  result: ActivationResult,
                ) => routeBackend(input, reservation, route, result),
              },
            }));
          const tcp = reservation.hostListeners
            .filter((listener) => !isHttpPortField(listener.field))
            .map((listener) => ({
              field: listener.field,
              options: {
                listener,
                routes: catalog.tcp.get(listener.field) ?? [],
                resolveBackend: (
                  route: GatewayProxyRoute,
                  _request: GatewayRouteRequest,
                  result: ActivationResult,
                ) => routeBackend(input, reservation, route, result),
              },
            }));
          const gateway = yield* makeGateway({
            http,
            tcp,
            activate: (capability) =>
              activate(capability).pipe(
                Effect.mapError((error) =>
                  error instanceof GatewayActivationError
                    ? error
                    : new GatewayActivationError({ message: error.message, cause: error }),
                ),
              ),
          }).pipe(Effect.provideService(Scope.Scope, ownerScope));
          yield* Ref.set(current, { input, reservation, gateway });
        }),
      );

    return { acquire, open, close } satisfies SupervisorIngress;
  });
