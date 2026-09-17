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
import type { GatewayActivity } from "../gateway/ActivityTracker.ts";
import {
  GatewayActivationError,
  PortUnavailableError,
  StackLifecycleConflictError,
  StackPreparationError,
  StackStateInvalidError,
  type StackError,
} from "../public/Errors.ts";
import { PORT_FIELDS, type PortField } from "../public/Status.ts";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import type { StackId } from "../public/StackId.ts";
import { routeCatalogFor, type GatewayApiMaterial } from "../gateway/RouteCatalog.ts";
import {
  GatewayRouteNotFoundError,
  type BackendEndpoint,
  makeGateway,
} from "../gateway/Gateway.ts";
import { makeHttpGateway, type HttpGateway } from "../gateway/HttpGateway.ts";
import { makeTcpGateway, type TcpGateway } from "../gateway/TcpGateway.ts";
import {
  makePortCoordinator,
  type PrivatePortIntent,
  type PublicPortIntent,
  type PortReservation,
} from "../state/PortCoordinator.ts";
import type { HostListener } from "./HostListener.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { privateBindingIntentsFor } from "../runtime/WorkloadRuntimeSpec.ts";
import { runtimeSpecFor } from "../runtime/WorkloadRuntimeSpec.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import { createExecutionPlan, type ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import {
  bindHeldPort,
  bindHostListener,
  hostListenerCoversAddress,
  isHttpPortField,
  type HeldPort,
} from "./HostListener.ts";
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

interface ListenerIntent {
  readonly enabled: boolean;
  readonly address: string;
  readonly port: "automatic" | number;
}

type ListenerIntents = Readonly<Record<PortField, ListenerIntent>>;

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
    activity?: GatewayActivity,
  ) => Effect.Effect<void, GatewayActivationError | StackError>;
  /** Close gateway, accepted sockets, and exact listeners; safe to call repeatedly. */
  readonly close: Effect.Effect<void, StackError>;
  /** Publish the concrete backend bindings returned after one instance starts. */
  readonly publish?: (
    instanceId: ServiceInstanceId,
    publications: ReadonlyArray<RuntimeBindingPublication>,
  ) => Effect.Effect<void, StackError>;
  /** Reserves and arms the shared Functions API without starting its lazy instance. */
  readonly armFunctionsApi?: (
    state: PersistedStackState,
    plan: ExecutionPlan,
  ) => Effect.Effect<void, GatewayActivationError | StackError>;
  /** Remove backend bindings after one instance stops or is destroyed. */
  readonly unpublish?: (
    instanceId: ServiceInstanceId,
    preserveListener?: boolean,
  ) => Effect.Effect<void, StackError>;
  /** Supplies the lifecycle callback used to wake a dormant instance listener. */
  readonly setInstanceActivator?: (
    activate: (instanceId: ServiceInstanceId) => Effect.Effect<void, StackError>,
  ) => Effect.Effect<void>;
  /** Installs the Supervisor-owned atomic traffic admission lease. */
  readonly setTrafficAcquirer?: (
    acquire: (
      instanceId: ServiceInstanceId,
      mode?: TrafficAdmissionMode,
    ) => Effect.Effect<TrafficLease, StackError>,
  ) => Effect.Effect<void>;
  /** Reports whether a dormant instance still has a bound demand-wake listener. */
  readonly isInstanceWakeable?: (instanceId: ServiceInstanceId) => Effect.Effect<boolean>;
}

export type TrafficAdmissionMode = "normal" | "startup-control";

export interface TrafficLease {
  readonly release: Effect.Effect<void>;
}

export interface SupervisorIngressOptions {
  readonly stackId: StackId;
  readonly stateRoot: string;
  readonly store: StackStateStore;
  readonly context: Context.Context<Crypto.Crypto | FileSystem.FileSystem | Path.Path>;
  readonly bindHost?: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<HostListener, PortUnavailableError, Scope.Scope>;
  readonly bindPrivate?: (
    address: string,
    port: number,
    binding: string,
  ) => Effect.Effect<HeldPort, PortUnavailableError, Scope.Scope>;
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

const listenerIntents = (input: LifecycleInput): ListenerIntents => {
  const usable = new Set(input.plan.routes.map(({ listener }) => listener));
  const select = <K extends keyof ListenerIntents>(field: K): ListenerIntents[K] =>
    usable.has(field)
      ? input.definition.listeners[field]
      : { ...input.definition.listeners[field], enabled: false };
  return {
    api: select("api"),
    database: select("database"),
    pooler: select("pooler"),
    studio: select("studio"),
    mailUi: select("mailUi"),
    smtp: select("smtp"),
    pop3: select("pop3"),
    functionsInspector: select("functionsInspector"),
  };
};

const publicBindings = (input: LifecycleInput): ReadonlyArray<PublicPortIntent> => {
  const intents = listenerIntents(input);
  const bindingForField: Partial<Record<PortField, string>> = {
    database: "sql",
    pooler: "pooler",
    studio: "studio",
    mailUi: "mailUi",
    smtp: "smtp",
    pop3: "pop3",
    functionsInspector: "inspector",
  };
  const configured = PORT_FIELDS.flatMap((listenerField): ReadonlyArray<PublicPortIntent> => {
    const intent = intents[listenerField];
    if (!intent.enabled) return [];
    if (listenerField === "api")
      return [
        {
          owner: "stack",
          binding: "api",
          listenerField,
          address: intent.address,
          port: intent.port,
        },
      ];
    const binding = bindingForField[listenerField];
    const workload = input.plan.workloads.find(
      (entry) =>
        entry.capability === (listenerField === "functionsInspector" ? "functions" : listenerField),
    );
    if (binding === undefined || workload === undefined) return [];
    return [
      {
        owner: "instance",
        instanceId: workload.instanceId,
        binding,
        listenerField,
        address: intent.address,
        port: intent.port,
      },
    ];
  });
  const endpointFields: Readonly<Record<string, Readonly<Record<string, PortField>>>> = {
    database: { sql: "database" },
    functions: { inspector: "functionsInspector" },
    studio: { studio: "studio" },
    mail: { smtp: "smtp", pop3: "pop3", mailUi: "mailUi" },
    pooler: { pooler: "pooler" },
  };
  const instanceEndpoints = input.plan.workloads.flatMap((workload) => {
    const instance = input.state.registry.instances.find(
      (entry) => entry.id === workload.instanceId,
    );
    const fields = instance === undefined ? undefined : endpointFields[instance.service];
    if (instance === undefined || fields === undefined) return [];
    return Object.entries(instance.config.endpoints).flatMap(([binding, endpoint]) => {
      const listenerField = fields[binding];
      if (listenerField === undefined || endpoint === undefined || endpoint.enabled === false)
        return [];
      return [
        {
          owner: "instance" as const,
          instanceId: instance.id,
          binding,
          listenerField,
          address: endpoint.address ?? "127.0.0.1",
          port:
            endpoint.port === undefined || endpoint.port === "auto"
              ? ("automatic" as const)
              : endpoint.port,
        },
      ];
    });
  });
  const unique = new Map<string, PublicPortIntent>();
  for (const intent of [...configured, ...instanceEndpoints]) {
    const key =
      intent.owner === "stack"
        ? `stack:${intent.binding}`
        : `instance:${intent.instanceId}:${intent.binding}`;
    if (!unique.has(key)) unique.set(key, intent);
  }
  return [...unique.values()];
};

const configuredListenerKeys = (input: LifecycleInput): ReadonlySet<string> => {
  const intents = listenerIntents(input);
  const bindingForField: Partial<Record<PortField, string>> = {
    database: "sql",
    pooler: "pooler",
    studio: "studio",
    mailUi: "mailUi",
    smtp: "smtp",
    pop3: "pop3",
    functionsInspector: "inspector",
  };
  const keys = new Set<string>(["stack:api"]);
  for (const field of PORT_FIELDS) {
    if (field === "api" || !intents[field].enabled) continue;
    const binding = bindingForField[field];
    const workload = input.plan.workloads.find(
      (entry) => entry.capability === (field === "functionsInspector" ? "functions" : field),
    );
    if (binding !== undefined && workload !== undefined)
      keys.add(`instance:${workload.instanceId}:${binding}`);
  }
  return keys;
};

const privateBindings = (input: LifecycleInput): ReadonlyArray<PrivatePortIntent> => {
  const workloads = new Map(input.plan.workloads.map((workload) => [workload.id, workload]));
  return privateBindingIntentsFor(input.plan, input.state).flatMap((intent) => {
    const workload = workloads.get(intent.workloadId);
    return workload === undefined ? [] : [{ ...intent, instanceId: workload.instanceId }];
  });
};

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
  route: Pick<GatewayProxyRoute, "capability" | "binding" | "instanceId">,
  activation: ActivationResult,
  published?: ReadonlyMap<string, ReadonlyArray<RuntimeBindingPublication>>,
) => {
  if (route.binding === undefined) return Effect.succeed(activation.endpoint);
  const workload = input.plan.workloads.find(
    (entry) =>
      entry.capability === route.capability &&
      (route.instanceId === undefined || entry.instanceId === route.instanceId),
  );
  const publishedEndpoint =
    workload === undefined
      ? undefined
      : publishedEndpointFor(published?.get(workload.instanceId), workload, route.binding);
  if (publishedEndpoint !== undefined) return Effect.succeed(publishedEndpoint);
  if (route.instanceId !== undefined && published !== undefined)
    return Effect.fail(
      new GatewayActivationError({
        message: `Service backend for ${route.instanceId} is not ready`,
      }),
    );
  const workloadIds = new Set(
    input.plan.workloads
      .filter(
        (entry) =>
          entry.capability === route.capability &&
          (route.instanceId === undefined || entry.instanceId === route.instanceId),
      )
      .map((entry) => entry.id),
  );
  const assignments = reservation.privateAssignments.filter(
    (entry) =>
      workloadIds.has(entry.workloadId) &&
      entry.binding === route.binding &&
      (route.instanceId === undefined || entry.instanceId === route.instanceId),
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

const publishedEndpointFor = (
  publications: ReadonlyArray<RuntimeBindingPublication> | undefined,
  workload: LifecycleInput["plan"]["workloads"][number],
  binding: string,
): BackendEndpoint | undefined =>
  publications?.find(
    (publication) =>
      publication.workloadId === workload.id &&
      (publication.binding === binding ||
        (binding === "primary" &&
          workload.capability === "database" &&
          publication.binding === "sql:internal")),
  )?.endpoint;

const publicationKey = (publication: RuntimeBindingPublication): string =>
  `${publication.workloadId}\u0000${publication.binding}`;

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
          readonly input?: LifecycleInput;
          readonly reservation: SupervisorIngressReservation;
          readonly scope: Scope.Scope;
          readonly gateway?: StackGateway;
        }
      | undefined
    >(undefined);
    const published = yield* Ref.make<
      ReadonlyMap<string, ReadonlyArray<RuntimeBindingPublication>>
    >(new Map());
    const instanceGateways = yield* Ref.make<ReadonlyMap<string, HttpGateway | TcpGateway>>(
      new Map(),
    );
    const apiGateway = yield* Ref.make<HttpGateway | undefined>(undefined);
    const armSharedFunctionsApi = yield* Ref.make(false);
    const instanceActivator = yield* Ref.make<
      ((instanceId: ServiceInstanceId) => Effect.Effect<void, StackError>) | undefined
    >(undefined);
    const trafficAcquirer = yield* Ref.make<
      | ((
          instanceId: ServiceInstanceId,
          mode?: TrafficAdmissionMode,
        ) => Effect.Effect<TrafficLease, StackError>)
      | undefined
    >(undefined);
    const activityFor = (
      instanceId: ServiceInstanceId,
      startupControl = false,
    ): GatewayActivity => ({
      track: (_capability, effect) =>
        Effect.acquireUseRelease(
          Ref.get(trafficAcquirer).pipe(
            Effect.flatMap((acquire) =>
              acquire === undefined
                ? Effect.fail(
                    new GatewayActivationError({
                      message: `Traffic admission is unavailable for ${instanceId}`,
                    }),
                  )
                : acquire(instanceId, startupControl ? "startup-control" : "normal").pipe(
                    Effect.mapError(
                      (error) =>
                        new GatewayActivationError({
                          message: error.message,
                          cause: error,
                        }),
                    ),
                  ),
            ),
          ),
          () => effect,
          (lease) => lease.release,
        ),
    });
    const coordinator = makePortCoordinator({
      stateRoot: options.stateRoot,
      store: options.store,
      bindHost: options.bindHost ?? bindHostListener,
      bindPrivate: options.bindPrivate ?? bindHeldPort,
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
            .acquire(options.stackId, publicBindings(input), privateBindings(input))
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
        if (entry !== undefined) yield* closeCurrent(entry);
        for (const gateway of (yield* Ref.get(instanceGateways)).values()) yield* gateway.close;
        const sharedApi = yield* Ref.get(apiGateway);
        if (sharedApi !== undefined) yield* sharedApi.close;
        yield* Ref.set(instanceGateways, new Map());
        yield* Ref.set(apiGateway, undefined);
        yield* Ref.set(published, new Map());
        yield* Ref.set(current, undefined);
      }),
    );

    const open = (
      input: LifecycleInput,
      reservation: SupervisorIngressReservation,
      activate: (
        capability: import("../public/Capability.ts").CapabilityName,
      ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>,
      activity?: GatewayActivity,
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
          const intents = listenerIntents(input);
          const adoptedKeys = configuredListenerKeys(input);
          const adoptedListeners = reservation.hostListeners.filter(
            (listener) => listener.routeKey === undefined || adoptedKeys.has(listener.routeKey),
          );
          const material = intents.api.enabled
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
          const http: HttpGatewayListenerOptions[] = adoptedListeners
            .filter((listener) => isHttpPortField(listener.field))
            .map((listener) => ({
              field: listener.field,
              key: listener.routeKey ?? listener.field,
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
                ) =>
                  Ref.get(published).pipe(
                    Effect.flatMap((value) =>
                      routeBackend(input, reservation, route, result, value),
                    ),
                  ),
              },
            }));
          const internalApiAddress =
            intents.api.enabled &&
            reservation.assignments.api !== undefined &&
            options.resolveInternalApiBindAddress !== undefined
              ? yield* options.resolveInternalApiBindAddress()
              : undefined;
          let internalApi: HostListener | undefined;
          if (internalApiAddress !== undefined && reservation.assignments.api !== undefined) {
            const covered = adoptedListeners.some(
              (listener) =>
                listener.field === "api" &&
                listener.port === reservation.assignments.api?.port &&
                hostListenerCoversAddress(listener, internalApiAddress),
            );
            if (!covered) {
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
                  ) =>
                    Ref.get(published).pipe(
                      Effect.flatMap((value) =>
                        routeBackend(input, reservation, route, result, value),
                      ),
                    ),
                },
              });
            }
          }
          const tcp = adoptedListeners
            .filter((listener) => !isHttpPortField(listener.field))
            .map((listener) => ({
              field: listener.field,
              key: listener.routeKey ?? listener.field,
              options: {
                listener,
                routes: catalog.tcp.get(listener.field) ?? [],
                resolveBackend: (
                  route: GatewayProxyRoute,
                  _request: GatewayRouteRequest,
                  result: ActivationResult,
                ) =>
                  Ref.get(published).pipe(
                    Effect.flatMap((value) =>
                      routeBackend(input, reservation, route, result, value),
                    ),
                  ),
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
                      : new GatewayActivationError({
                          message: error.message,
                          cause: error,
                          recovery:
                            error instanceof StackLifecycleConflictError
                              ? error.recovery
                              : undefined,
                        }),
                  ),
                ),
              activity,
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

    const publish = (
      instanceId: ServiceInstanceId,
      publications: ReadonlyArray<RuntimeBindingPublication>,
    ): Effect.Effect<void, StackError> =>
      lock.withPermit(
        Effect.gen(function* () {
          // A dormant listener remains bound so its first request can wake the instance. Reusing
          // that listener during wake avoids a close/rebind race on the durable public port.
          yield* Ref.update(published, (current) => {
            const previous = current.get(instanceId) ?? [];
            const merged = new Map(
              previous.map((publication) => [publicationKey(publication), publication]),
            );
            for (const publication of publications)
              merged.set(publicationKey(publication), publication);
            return new Map(current).set(instanceId, [...merged.values()]);
          });
          const stackGatewayOpen = (yield* Ref.get(current))?.gateway !== undefined;
          const currentEntry = yield* Ref.get(current);
          const reservationListeners = currentEntry?.reservation.hostListeners ?? [];
          const adoptedKeys =
            currentEntry?.input === undefined
              ? new Set<string>(["stack:api"])
              : configuredListenerKeys(currentEntry.input);
          const adoptedListeners = reservationListeners.filter(
            (listener) => listener.routeKey === undefined || adoptedKeys.has(listener.routeKey),
          );
          const existing = yield* Ref.get(instanceGateways);
          const state = yield* options.store.read(options.stackId).pipe(
            Effect.provideContext(options.context),
            Effect.mapError(
              (error) => new StackStateInvalidError({ message: error.message, cause: error }),
            ),
          );
          if (state === undefined)
            return yield* new StackStateInvalidError({
              message: "Stack state is missing while publishing instance endpoints",
            });
          const plan = yield* createExecutionPlan(state.runtime, state.registry).pipe(
            Effect.mapError(
              (error) => new StackStateInvalidError({ message: error.message, cause: error }),
            ),
          );
          const gatewayKinds: Readonly<
            Record<
              string,
              {
                readonly field: PortField;
                readonly capability: import("../public/Capability.ts").CapabilityName;
                readonly protocol: "http" | "tcp";
                readonly routeBinding: string;
                readonly workloadBinding: string;
              }
            >
          > = {
            sql: {
              field: "database",
              capability: "database",
              protocol: "tcp",
              routeBinding: "primary",
              workloadBinding: "sql:internal",
            },
            pooler: {
              field: "pooler",
              capability: "pooler",
              protocol: "tcp",
              routeBinding: "primary",
              workloadBinding: "primary",
            },
            inspector: {
              field: "functionsInspector",
              capability: "functions",
              protocol: "http",
              routeBinding: "inspector",
              workloadBinding: "inspector",
            },
            studio: {
              field: "studio",
              capability: "studio",
              protocol: "http",
              routeBinding: "primary",
              workloadBinding: "primary",
            },
            mailUi: {
              field: "mailUi",
              capability: "mail",
              protocol: "http",
              routeBinding: "ui",
              workloadBinding: "ui",
            },
            smtp: {
              field: "smtp",
              capability: "mail",
              protocol: "tcp",
              routeBinding: "smtp",
              workloadBinding: "smtp",
            },
            pop3: {
              field: "pop3",
              capability: "mail",
              protocol: "tcp",
              routeBinding: "pop3",
              workloadBinding: "pop3",
            },
          };
          const publishSharedFunctionsApi = (
            workload: (typeof plan.workloads)[number],
          ): Effect.Effect<void, StackError> =>
            Effect.gen(function* () {
              if ((yield* Ref.get(apiGateway)) !== undefined) return;
              if ((yield* Ref.get(current))?.gateway !== undefined) return;
              const apiAssignment = state.ports.find(
                (entry) => entry.owner === "stack" && entry.binding === "api",
              );
              if (apiAssignment === undefined) return;
              const reservedListener = (yield* Ref.get(current))?.reservation.hostListeners.find(
                (entry) =>
                  entry.routeKey === "stack:api" &&
                  entry.field === "api" &&
                  entry.port === apiAssignment.port,
              );
              const listener =
                reservedListener ??
                (yield* (options.bindHost ?? bindHostListener)(
                  apiAssignment.address,
                  apiAssignment.port,
                  "api",
                ).pipe(Effect.provideService(Scope.Scope, ownerScope)));
              const route: GatewayProxyRoute = {
                capability: "functions",
                instanceId,
                match: (request) => request.path.startsWith("/functions/v1/"),
                upstreamPath: (request) => {
                  const path = request.path.slice("/functions/v1".length);
                  return path.length === 0 ? "/" : path;
                },
              };
              const activate = (_capability: import("../public/Capability.ts").CapabilityName) =>
                Effect.gen(function* () {
                  let activeEndpoint = publishedEndpointFor(
                    (yield* Ref.get(published)).get(instanceId),
                    workload,
                    "primary",
                  );
                  if (activeEndpoint === undefined) {
                    const wake = yield* Ref.get(instanceActivator);
                    if (wake === undefined)
                      return yield* new GatewayActivationError({
                        message: "Functions are dormant",
                      });
                    yield* wake(instanceId);
                    activeEndpoint = publishedEndpointFor(
                      (yield* Ref.get(published)).get(instanceId),
                      workload,
                      "primary",
                    );
                  }
                  return activeEndpoint === undefined
                    ? yield* new GatewayActivationError({
                        message: "Functions backend is unavailable",
                      })
                    : { capability: "functions" as const, instanceId, endpoint: activeEndpoint };
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof GatewayActivationError
                      ? error
                      : new GatewayActivationError({ message: error.message, cause: error }),
                  ),
                );
              const gateway = yield* makeHttpGateway({
                listener,
                routes: [route],
                activate,
                resolveBackend: () =>
                  Ref.get(published).pipe(
                    Effect.flatMap((current) => {
                      const active = publishedEndpointFor(
                        current.get(instanceId),
                        workload,
                        "primary",
                      );
                      return active === undefined
                        ? Effect.fail(
                            new GatewayActivationError({
                              message: `Functions backend for ${instanceId} is not published`,
                            }),
                          )
                        : Effect.succeed(active);
                    }),
                  ),
                activity: activityFor(instanceId),
              }).pipe(Effect.provideService(Scope.Scope, ownerScope));
              yield* Ref.set(apiGateway, gateway);
            });
          // Functions expose their main HTTP route through the shared API listener. The inspector
          // listener is optional, so publication must follow the workload start itself.
          const functionsWorkload = plan.workloads.find(
            (entry) => entry.instanceId === instanceId && entry.capability === "functions",
          );
          if (functionsWorkload !== undefined) {
            if (
              publishedEndpointFor(
                (yield* Ref.get(published)).get(instanceId),
                functionsWorkload,
                "primary",
              ) !== undefined ||
              (yield* Ref.get(armSharedFunctionsApi))
            )
              yield* publishSharedFunctionsApi(functionsWorkload);
          }
          const assignments =
            state?.ports.filter(
              (entry) => entry.owner === "instance" && entry.instanceId === instanceId,
            ) ?? [];
          for (const assignment of assignments) {
            const kind = gatewayKinds[assignment.binding];
            if (kind === undefined) continue;
            if (
              stackGatewayOpen &&
              adoptedListeners.some(
                (listener) => listener.field === kind.field && listener.port === assignment.port,
              )
            )
              continue;
            if (existing.has(`${instanceId}:${assignment.binding}`)) continue;
            const workload = plan.workloads.find((entry) => {
              if (entry.instanceId !== instanceId) return false;
              const spec = runtimeSpecFor(entry);
              return (
                spec !== undefined && Object.keys(spec.bindings).includes(kind.workloadBinding)
              );
            });
            const endpoint =
              workload === undefined
                ? undefined
                : publishedEndpointFor(
                    (yield* Ref.get(published)).get(instanceId),
                    workload,
                    kind.workloadBinding,
                  );
            if (endpoint === undefined) continue;
            const reservedListener = reservationListeners.find(
              (listener) =>
                listener.routeKey === `instance:${instanceId}:${assignment.binding}` &&
                listener.port === assignment.port,
            );
            const listener =
              reservedListener ??
              (yield* (options.bindHost ?? bindHostListener)(
                assignment.address,
                assignment.port,
                kind.field,
              ).pipe(Effect.provideService(Scope.Scope, ownerScope)));
            const route: import("../gateway/Gateway.ts").GatewayProxyRoute = {
              capability: kind.capability,
              instanceId,
              binding: kind.routeBinding,
              match: () => true,
            };
            const activate = (_capability: import("../public/Capability.ts").CapabilityName) =>
              Effect.gen(function* () {
                const current = yield* Ref.get(published);
                const active = current.get(instanceId);
                let activeEndpoint =
                  workload === undefined
                    ? undefined
                    : publishedEndpointFor(active, workload, kind.workloadBinding);
                if (activeEndpoint === undefined) {
                  const activateInstance = yield* Ref.get(instanceActivator);
                  if (activateInstance === undefined)
                    return yield* new GatewayActivationError({
                      message: `Service instance ${instanceId} is dormant`,
                    });
                  yield* activateInstance(instanceId);
                  const refreshed = (yield* Ref.get(published)).get(instanceId);
                  activeEndpoint =
                    workload === undefined
                      ? undefined
                      : publishedEndpointFor(refreshed, workload, kind.workloadBinding);
                }
                return activeEndpoint === undefined
                  ? yield* new GatewayActivationError({
                      message: `Service instance ${instanceId} did not publish a backend endpoint`,
                    })
                  : { capability: kind.capability, instanceId, endpoint: activeEndpoint };
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof GatewayActivationError
                    ? error
                    : new GatewayActivationError({ message: error.message, cause: error }),
                ),
              );
            const gateway =
              kind.protocol === "http"
                ? yield* makeHttpGateway({
                    listener,
                    routes: [route],
                    activate,
                    resolveBackend: () =>
                      Ref.get(published).pipe(
                        Effect.flatMap((current) => {
                          const active =
                            workload === undefined
                              ? endpoint
                              : publishedEndpointFor(
                                  current.get(instanceId),
                                  workload,
                                  kind.workloadBinding,
                                );
                          return active === undefined
                            ? Effect.fail(
                                new GatewayActivationError({
                                  message: `Service backend for ${instanceId} is not published`,
                                }),
                              )
                            : Effect.succeed(active);
                        }),
                      ),
                    activity: activityFor(instanceId, kind.routeBinding === "inspector"),
                  }).pipe(Effect.provideService(Scope.Scope, ownerScope))
                : yield* makeTcpGateway({
                    listener,
                    routes: [route],
                    activate,
                    resolveBackend: () =>
                      Ref.get(published).pipe(
                        Effect.flatMap((current) => {
                          const active =
                            workload === undefined
                              ? endpoint
                              : publishedEndpointFor(
                                  current.get(instanceId),
                                  workload,
                                  kind.workloadBinding,
                                );
                          return active === undefined
                            ? Effect.fail(
                                new GatewayActivationError({
                                  message: `Service backend for ${instanceId} is not published`,
                                }),
                              )
                            : Effect.succeed(active);
                        }),
                      ),
                    activity: activityFor(instanceId),
                  }).pipe(Effect.provideService(Scope.Scope, ownerScope));
            yield* Ref.update(instanceGateways, (current) =>
              new Map(current).set(`${instanceId}:${assignment.binding}`, gateway),
            );
          }
        }),
      );
    const armFunctionsApi = (
      state: PersistedStackState,
      plan: ExecutionPlan,
    ): Effect.Effect<void, GatewayActivationError | StackError> =>
      Effect.gen(function* () {
        const functionsWorkload = plan.workloads.find((entry) => entry.capability === "functions");
        if (functionsWorkload === undefined) return;
        const api = state.listeners.api;
        if (api?.enabled === false) return;
        const reservationScope = Scope.forkUnsafe(ownerScope);
        const reservation = yield* coordinator
          .acquire(
            options.stackId,
            [
              {
                owner: "stack",
                binding: "api",
                listenerField: "api",
                address: api?.address ?? "127.0.0.1",
                port: api?.port ?? "automatic",
              },
            ],
            [],
          )
          .pipe(
            Effect.provideContext(options.context),
            Effect.provideService(Scope.Scope, reservationScope),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Scope.close(reservationScope, exit),
            ),
          );
        yield* Ref.set(current, {
          reservation: { ...reservation, fresh: true, ownershipToken: Symbol() },
          scope: reservationScope,
        });
        yield* Ref.set(armSharedFunctionsApi, true);
        yield* publish(functionsWorkload.instanceId, []).pipe(
          Effect.ensuring(Ref.set(armSharedFunctionsApi, false)),
        );
      });
    const unpublish = (
      instanceId: ServiceInstanceId,
      preserveListener = false,
    ): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        if (!preserveListener) {
          const gateways = yield* Ref.get(instanceGateways);
          const owned = [...gateways.entries()].filter(([key]) => key.startsWith(`${instanceId}:`));
          for (const [key, gateway] of owned) {
            yield* gateway.close;
            yield* Ref.update(instanceGateways, (current) => {
              const next = new Map(current);
              next.delete(key);
              return next;
            });
          }
        }
        yield* Ref.update(published, (current) => {
          const next = new Map(current);
          next.delete(instanceId);
          return next;
        });
      });
    const setInstanceActivator = (
      activate: (instanceId: ServiceInstanceId) => Effect.Effect<void, StackError>,
    ): Effect.Effect<void> => Ref.set(instanceActivator, activate);
    const setTrafficAcquirer = (
      acquire: (
        instanceId: ServiceInstanceId,
        mode?: TrafficAdmissionMode,
      ) => Effect.Effect<TrafficLease, StackError>,
    ): Effect.Effect<void> => Ref.set(trafficAcquirer, acquire);
    const isInstanceWakeable = (instanceId: ServiceInstanceId): Effect.Effect<boolean> =>
      Ref.get(instanceGateways).pipe(
        Effect.map((current) =>
          [...current.keys()].some((key) => key.startsWith(`${instanceId}:`)),
        ),
      );
    return {
      acquire,
      open,
      close,
      publish,
      armFunctionsApi,
      unpublish,
      setInstanceActivator,
      setTrafficAcquirer,
      isInstanceWakeable,
    } satisfies SupervisorIngress;
  });
