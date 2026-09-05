import { Context, Crypto, Effect, Exit, FileSystem, Path, Ref, Scope, Semaphore } from "effect";
import type { LifecycleInput } from "./Lifecycle.ts";
import type {
  ActivationResult,
  GatewayRoute,
  GatewayProxyRoute,
  GatewayRouteRequest,
  HttpGatewayListenerOptions,
  StackGateway,
} from "../gateway/Gateway.ts";
import {
  GatewayActivationError,
  PortUnavailableError,
  StackPreparationError,
  type StackError,
} from "../public/Errors.ts";
import type { PortField } from "../public/Status.ts";
import { routeCatalogFor, type GatewayApiMaterial } from "../gateway/RouteCatalog.ts";
import { GatewayRouteNotFoundError, makeGateway } from "../gateway/Gateway.ts";
import {
  makePortCoordinator,
  type HostListener,
  type ListenerIntents,
  type PortReservation,
} from "../state/PortCoordinator.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { privateBindingIntentsFor } from "../runtime/WorkloadRuntimeSpec.ts";
import { bindHostListener, checkHostPort, isHttpPortField } from "./HostListener.ts";
import {
  AUTH_ANON_KEY_SLOT,
  AUTH_PUBLISHABLE_KEY_SLOT,
  AUTH_SECRET_KEY_SLOT,
  AUTH_SERVICE_ROLE_KEY_SLOT,
} from "../state/SecretStore.ts";

interface SupervisorIngressReservation extends PortReservation {
  /** False when this accepted definition already owns the exact listeners and gateway. */
  readonly fresh: boolean;
  /** Stable identity for the reservation across non-fresh reacquisition views. */
  readonly ownershipToken: symbol;
}

export interface SupervisorIngress {
  /** Reserve durable ports and bind public listeners before workload launch. */
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
  readonly stateRoot: string;
  readonly store: StackStateStore;
  readonly context: Context.Context<Crypto.Crypto | FileSystem.FileSystem | Path.Path>;
  /** Optional host-port seams for embedding tests; production uses native listeners. */
  readonly checkHostPort?: (
    address: string,
    port: number,
    field: string,
  ) => Effect.Effect<void, PortUnavailableError>;
  readonly bindHost?: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<HostListener, PortUnavailableError, Scope.Scope>;
  /** Resolves an internal host bind address for container callbacks when required. */
  readonly resolveInternalApiBindAddress?: () => Effect.Effect<string | undefined>;
  /** Resolver may be replaced by the production credential owner. */
  readonly apiMaterial?: (
    state: LifecycleInput["state"],
  ) => Effect.Effect<GatewayApiMaterial, StackPreparationError>;
  /** Resolves the accepted definition's Auth templates for live local serving. */
  readonly resolveAuthTemplates?: (state: LifecycleInput["state"]) => Effect.Effect<
    ReadonlyArray<{
      readonly id: string;
      readonly canonicalPath: string;
      readonly extension: string;
    }>,
    StackPreparationError
  >;
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
  const publishableKey = get(AUTH_PUBLISHABLE_KEY_SLOT);
  const secretKey = get(AUTH_SECRET_KEY_SLOT);
  const anonJwt = get(AUTH_ANON_KEY_SLOT);
  const serviceRoleJwt = get(AUTH_SERVICE_ROLE_KEY_SLOT);
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
  const workloadIds = new Set(
    input.plan.workloads
      .filter((entry) => entry.capability === route.capability)
      .map((entry) => entry.id),
  );
  const assignments = reservation.privateAssignments.filter(
    (entry) => workloadIds.has(entry.workloadId) && entry.binding === route.binding,
  );
  const [assignment, ...additionalAssignments] = assignments;
  if (assignment === undefined || additionalAssignments.length > 0)
    return Effect.fail(
      new GatewayActivationError({
        message:
          assignment === undefined
            ? "Gateway private binding is unavailable"
            : "Gateway private binding is ambiguous",
      }),
    );
  return Effect.succeed({ host: "127.0.0.1", port: assignment.port });
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
          readonly scope: Scope.Scope;
          readonly gateway?: StackGateway;
        }
      | undefined
    >(undefined);
    const coordinator = makePortCoordinator({
      stateRoot: options.stateRoot,
      store: options.store,
      checkHostPort: options.checkHostPort ?? checkHostPort,
      bindHost: options.bindHost ?? bindHostListener,
    });
    const acquire = (
      input: LifecycleInput,
    ): Effect.Effect<SupervisorIngressReservation, StackError> =>
      lock.withPermit(
        Effect.gen(function* () {
          const existing = yield* Ref.get(current);
          // A Supervisor owns one ingress reservation for its running session. Definition
          // changes are rejected while running and a stopped session closes this reservation,
          // so a live reservation can always be reused without a configuration fingerprint.
          if (existing !== undefined) return { ...existing.reservation, fresh: false };
          const reservationScope = Scope.forkUnsafe(ownerScope);
          const reservation = yield* coordinator
            .planAndReserve(options.stackId, listenerIntents(input), {
              privateBindings: privateBindingIntentsFor(input.plan),
            })
            .pipe(
              Effect.provideContext(options.context),
              Effect.provideService(Scope.Scope, reservationScope),
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : Scope.close(reservationScope, exit),
              ),
            );
          const owned: SupervisorIngressReservation = {
            ...reservation,
            fresh: true,
            ownershipToken: Symbol(),
          };
          yield* Ref.set(current, { input, reservation: owned, scope: reservationScope });
          return owned;
        }),
      );

    const closeCurrent = (entry: {
      readonly reservation: SupervisorIngressReservation;
      readonly gateway?: StackGateway;
      readonly scope: Scope.Scope;
    }): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        if (entry.gateway !== undefined) yield* entry.gateway.close;
        yield* Scope.close(entry.scope, Exit.void);
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
            entry === undefined ||
            entry.reservation.ownershipToken !== reservation.ownershipToken
          )
            return yield* new GatewayActivationError({
              message: "Gateway reservation is no longer current",
            });
          if (entry.gateway !== undefined) return;
          const material = input.definition.listeners.api.enabled
            ? yield* (options.apiMaterial ?? defaultApiMaterial)(input.state)
            : undefined;
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
          const http: HttpGatewayListenerOptions[] = reservation.hostListeners
            .filter((listener) => isHttpPortField(listener.field))
            .map((listener) => ({
              field: listener.field,
              key: listener.field,
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
          const internalApiAddress =
            input.definition.listeners.api.enabled &&
            reservation.assignments.api !== undefined &&
            options.resolveInternalApiBindAddress !== undefined
              ? yield* options.resolveInternalApiBindAddress()
              : undefined;
          let internalApi: HostListener | undefined;
          if (internalApiAddress !== undefined && reservation.assignments.api !== undefined) {
            internalApi = yield* (options.bindHost ?? bindHostListener)(
              internalApiAddress,
              reservation.assignments.api.port,
              "api",
            ).pipe(Effect.provideService(Scope.Scope, entry.scope));
            http.push({
              field: "api",
              key: "api:internal",
              options: {
                listener: internalApi,
                routes:
                  templateRoute !== undefined
                    ? [templateRoute, ...(catalog.http.get("api") ?? [])]
                    : (catalog.http.get("api") ?? []),
                resolveBackend: (
                  route: GatewayProxyRoute,
                  _request: GatewayRouteRequest,
                  result: ActivationResult,
                ) => routeBackend(input, reservation, route, result),
              },
            });
          }
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
          const gatewayResult = yield* Effect.exit(
            makeGateway({
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
            }).pipe(Effect.provideService(Scope.Scope, entry.scope)),
          );
          if (Exit.isFailure(gatewayResult)) {
            if (internalApi !== undefined) yield* internalApi.close.pipe(Effect.ignore);
            return yield* Effect.failCause(gatewayResult.cause);
          }
          const gateway = gatewayResult.value;
          yield* Ref.set(current, {
            input,
            reservation,
            scope: entry.scope,
            gateway,
          });
        }),
      );

    return { acquire, open, close } satisfies SupervisorIngress;
  });
