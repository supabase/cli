import { Context, Crypto, Effect, Exit, FileSystem, Path, Ref, Scope, Semaphore } from "effect";
import type { GatewayRoute, GatewayProxyRoute } from "../gateway/Gateway.ts";
import type { GatewayActivity } from "../gateway/ActivityTracker.ts";
import {
  GatewayActivationError,
  PortUnavailableError,
  StackPreparationError,
  StackStateInvalidError,
  type StackError,
} from "../public/Errors.ts";
import type { PortField } from "../public/Status.ts";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import type { StackId } from "../public/StackId.ts";
import { routeCatalogFor, type GatewayApiMaterial } from "../gateway/RouteCatalog.ts";
import {
  GatewayRouteNotFoundError,
  type BackendEndpoint,
  isGatewayProxyRoute,
} from "../gateway/Gateway.ts";
import { makeHttpGateway, type HttpGateway } from "../gateway/HttpGateway.ts";
import { makeTcpGateway, type TcpGateway } from "../gateway/TcpGateway.ts";
import { makePortCoordinator, type PortReservation } from "../state/PortCoordinator.ts";
import type { HostListener } from "./HostListener.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { runtimeSpecFor } from "../runtime/WorkloadRuntimeSpec.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import { createExecutionPlan, type ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import {
  bindHeldPort,
  bindHostListener,
  hostListenerCoversAddress,
  type HeldPort,
} from "./HostListener.ts";
import {
  AUTH_ANON_KEY_SLOT,
  AUTH_PUBLISHABLE_KEY_SLOT,
  AUTH_SECRET_KEY_SLOT,
  AUTH_SERVICE_ROLE_KEY_SLOT,
} from "../state/SecretStore.ts";

export type TrafficAdmissionMode = "normal" | "startup-control";

export interface TrafficLease {
  readonly release: Effect.Effect<void>;
}

export interface SupervisorIngress {
  /** Close gateways and exact listeners; safe to call repeatedly. */
  readonly close: Effect.Effect<void, StackError>;
  /** Publish the concrete backend bindings returned after one instance starts. */
  readonly publish?: (
    instanceId: ServiceInstanceId,
    publications: ReadonlyArray<RuntimeBindingPublication>,
  ) => Effect.Effect<void, StackError>;
  /** Bind all admitted lazy listeners and the shared API before lazy workloads start. */
  readonly armLazyIngress?: (
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
  /** Installs the Supervisor owned atomic traffic admission lease. */
  readonly setTrafficAcquirer?: (
    acquire: (
      instanceId: ServiceInstanceId,
      mode?: TrafficAdmissionMode,
    ) => Effect.Effect<TrafficLease, StackError>,
  ) => Effect.Effect<void>;
  /** Reports whether a dormant instance still has a bound demand wake listener. */
  readonly isInstanceWakeable?: (instanceId: ServiceInstanceId) => Effect.Effect<boolean>;
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
    state: PersistedStackState,
  ) => Effect.Effect<GatewayApiMaterial, StackPreparationError>;
  /** Resolves the accepted definition's Auth templates for live local serving. */
  readonly resolveAuthTemplates?: (state: PersistedStackState) => Effect.Effect<
    ReadonlyArray<{
      readonly id: string;
      readonly canonicalPath: string;
      readonly extension: string;
    }>,
    StackPreparationError
  >;
}

const defaultApiMaterial = (
  state: PersistedStackState,
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

const publishedEndpointFor = (
  publications: ReadonlyArray<RuntimeBindingPublication> | undefined,
  workload: ExecutionPlan["workloads"][number],
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

const publicWorkloadFor = (
  plan: ExecutionPlan,
  instanceId: ServiceInstanceId,
  capability: import("../public/Capability.ts").CapabilityName,
  listener: PortField,
): ExecutionPlan["workloads"][number] | undefined => {
  const candidates = plan.workloads.filter(
    (entry) => entry.instanceId === instanceId && entry.capability === capability,
  );
  return (
    candidates.find((entry) => entry.readiness.portField === listener) ??
    (candidates.length === 1 ? candidates[0] : undefined)
  );
};

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

/** Compose the Supervisor owned gateways under one owner scope. */
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
    const published = yield* Ref.make<
      ReadonlyMap<string, ReadonlyArray<RuntimeBindingPublication>>
    >(new Map());
    const instanceGateways = yield* Ref.make<ReadonlyMap<string, HttpGateway | TcpGateway>>(
      new Map(),
    );
    const apiGateway = yield* Ref.make<HttpGateway | undefined>(undefined);
    const apiInternalGateway = yield* Ref.make<HttpGateway | undefined>(undefined);
    const apiReservation = yield* Ref.make<
      { readonly reservation: PortReservation; readonly scope: Scope.Scope } | undefined
    >(undefined);
    const apiGatewayInstances = yield* Ref.make<ReadonlySet<ServiceInstanceId>>(new Set());
    const sharedApiRoutes: GatewayRoute[] = [];
    const sharedApiRouteInstances = new Map<
      import("../public/Capability.ts").CapabilityName,
      ServiceInstanceId
    >();
    const armSharedApi = yield* Ref.make(false);
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
        Effect.uninterruptibleMask((restore) =>
          Effect.acquireUseRelease(
            restore(
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
            ),
            () => restore(effect),
            (lease) => lease.release,
          ),
        ),
    });
    const coordinator = makePortCoordinator({
      stateRoot: options.stateRoot,
      store: options.store,
      bindHost: options.bindHost ?? bindHostListener,
      bindPrivate: options.bindPrivate ?? bindHeldPort,
    });
    const releaseSharedApi = Effect.gen(function* () {
      const sharedApi = yield* Ref.get(apiGateway);
      if (sharedApi !== undefined) yield* sharedApi.close;
      const sharedApiInternal = yield* Ref.get(apiInternalGateway);
      if (sharedApiInternal !== undefined) yield* sharedApiInternal.close;
      const reservation = yield* Ref.get(apiReservation);
      if (reservation !== undefined) yield* Scope.close(reservation.scope, Exit.void);
      yield* Ref.set(apiGateway, undefined);
      yield* Ref.set(apiInternalGateway, undefined);
      yield* Ref.set(apiReservation, undefined);
      yield* Ref.set(apiGatewayInstances, new Set());
      sharedApiRoutes.splice(0, sharedApiRoutes.length);
      sharedApiRouteInstances.clear();
    });
    const closeUnlocked: Effect.Effect<void, StackError> = Effect.gen(function* () {
      for (const gateway of (yield* Ref.get(instanceGateways)).values()) yield* gateway.close;
      yield* releaseSharedApi;
      yield* Ref.set(instanceGateways, new Map());
      yield* Ref.set(published, new Map());
    });
    const close: Effect.Effect<void, StackError> = lock.withPermit(closeUnlocked);
    const publishUnlocked = (
      instanceId: ServiceInstanceId,
      publications: ReadonlyArray<RuntimeBindingPublication>,
    ): Effect.Effect<void, StackError> =>
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
        const apiEnabled =
          plan.routes.some((route) => route.listener === "api" && route.protocol === "http") &&
          state.listeners.api?.enabled !== false;
        const admittedApiInstances = new Set(
          state.registry.instances
            .filter(
              (instance) => instance.config.enabled !== false && instance.intent === "started",
            )
            .map((instance) => instance.id),
        );
        const apiRoutes =
          routeCatalogFor(
            plan,
            apiEnabled ? yield* (options.apiMaterial ?? defaultApiMaterial)(state) : undefined,
          )
            .http.get("api")
            ?.filter(
              (route): route is GatewayProxyRoute & { readonly instanceId: ServiceInstanceId } =>
                isGatewayProxyRoute(route) &&
                route.instanceId !== undefined &&
                admittedApiInstances.has(route.instanceId),
            ) ?? [];
        const publishSharedApi = (): Effect.Effect<void, StackError> =>
          Effect.gen(function* () {
            const apiAssignment = state.ports.find(
              (entry) => entry.owner === "stack" && entry.binding === "api",
            );
            if (apiAssignment === undefined || apiRoutes.length === 0) return;
            let existingGateway = yield* Ref.get(apiGateway);
            if (
              existingGateway !== undefined &&
              (existingGateway.address !== apiAssignment.address ||
                existingGateway.port !== apiAssignment.port)
            ) {
              yield* existingGateway.close;
              const existingInternalGateway = yield* Ref.get(apiInternalGateway);
              if (existingInternalGateway !== undefined) yield* existingInternalGateway.close;
              const existingReservation = yield* Ref.get(apiReservation);
              if (existingReservation !== undefined)
                yield* Scope.close(existingReservation.scope, Exit.void);
              yield* Ref.set(apiGateway, undefined);
              yield* Ref.set(apiInternalGateway, undefined);
              yield* Ref.set(apiReservation, undefined);
              existingGateway = undefined;
            }
            const routeInstances = new Map(
              apiRoutes.map((route) => [route.capability, route.instanceId]),
            );
            const routeInstanceIds = new Set(apiRoutes.map((route) => route.instanceId));
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
                      return resolveTemplates(state).pipe(
                        Effect.mapError(
                          () =>
                            new GatewayRouteNotFoundError({ message: "Auth template not found" }),
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
            const routes = apiRoutes.map((route) => {
              const workload = publicWorkloadFor(plan, route.instanceId, route.capability, "api");
              const binding = route.binding ?? "primary";
              return {
                ...route,
                binding,
                prepare: () =>
                  Effect.gen(function* () {
                    let endpoint =
                      workload === undefined
                        ? undefined
                        : publishedEndpointFor(
                            (yield* Ref.get(published)).get(route.instanceId),
                            workload,
                            binding,
                          );
                    if (endpoint === undefined) {
                      const latestState = yield* options.store.read(options.stackId).pipe(
                        Effect.provideContext(options.context),
                        Effect.mapError(
                          (error) =>
                            new GatewayActivationError({
                              message: "Unable to inspect API instance state",
                              cause: error,
                            }),
                        ),
                      );
                      const instance = latestState?.registry.instances.find(
                        (entry) => entry.id === route.instanceId,
                      );
                      if (
                        instance === undefined ||
                        instance.config.enabled === false ||
                        instance.intent !== "started"
                      )
                        return yield* new GatewayActivationError({
                          message: `${route.capability} is not admitted for wake`,
                        });
                      const wake = yield* Ref.get(instanceActivator);
                      if (wake === undefined)
                        return yield* new GatewayActivationError({
                          message: `${route.capability} is dormant`,
                        });
                      yield* wake(route.instanceId);
                      endpoint =
                        workload === undefined
                          ? undefined
                          : publishedEndpointFor(
                              (yield* Ref.get(published)).get(route.instanceId),
                              workload,
                              binding,
                            );
                    }
                    return endpoint === undefined
                      ? yield* new GatewayActivationError({
                          message: `${route.capability} backend for ${route.instanceId} is unavailable`,
                        })
                      : { resolveBackend: () => Effect.succeed(endpoint) };
                  }).pipe(
                    Effect.mapError((error) =>
                      error instanceof GatewayActivationError
                        ? error
                        : new GatewayActivationError({ message: error.message, cause: error }),
                    ),
                  ),
              } satisfies GatewayProxyRoute;
            });
            const nextRoutes = templateRoute === undefined ? routes : [templateRoute, ...routes];
            sharedApiRoutes.splice(0, sharedApiRoutes.length, ...nextRoutes);
            sharedApiRouteInstances.clear();
            for (const [capability, routeInstanceId] of routeInstances)
              sharedApiRouteInstances.set(capability, routeInstanceId);
            if (existingGateway !== undefined) {
              yield* Ref.set(apiGatewayInstances, routeInstanceIds);
              return;
            }
            const reservedListener = (yield* Ref.get(
              apiReservation,
            ))?.reservation.hostListeners.find(
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
            const internalAddress = options.resolveInternalApiBindAddress
              ? yield* options.resolveInternalApiBindAddress()
              : undefined;
            const internalListener =
              internalAddress !== undefined && !hostListenerCoversAddress(listener, internalAddress)
                ? yield* (options.bindHost ?? bindHostListener)(
                    internalAddress,
                    apiAssignment.port,
                    "api",
                  ).pipe(Effect.provideService(Scope.Scope, ownerScope))
                : undefined;
            const activity: GatewayActivity = {
              track: (capability, effect) => {
                const instance = sharedApiRouteInstances.get(capability);
                return instance === undefined
                  ? effect
                  : activityFor(instance).track(capability, effect);
              },
            };
            const gatewayOptions = {
              routes: sharedApiRoutes,
              activate: (capability: import("../public/Capability.ts").CapabilityName) =>
                Effect.succeed({
                  capability,
                  endpoint: { host: "127.0.0.1", port: 1 },
                }),
              activity,
            };
            const gateway = yield* makeHttpGateway({
              listener,
              ...gatewayOptions,
            }).pipe(Effect.provideService(Scope.Scope, ownerScope));
            const internalGateway =
              internalListener === undefined
                ? undefined
                : yield* makeHttpGateway({
                    listener: internalListener,
                    ...gatewayOptions,
                  }).pipe(Effect.provideService(Scope.Scope, ownerScope));
            yield* Ref.set(apiGateway, gateway);
            yield* Ref.set(apiInternalGateway, internalGateway);
            yield* Ref.set(apiGatewayInstances, routeInstanceIds);
          });
        if (!apiEnabled) {
          yield* releaseSharedApi;
        } else if (
          apiRoutes.length > 0 &&
          (publications.length > 0 || (yield* Ref.get(armSharedApi)))
        ) {
          yield* publishSharedApi();
        }
        const assignments =
          state?.ports.filter(
            (entry) => entry.owner === "instance" && entry.instanceId === instanceId,
          ) ?? [];
        for (const assignment of assignments) {
          const kind = gatewayKinds[assignment.binding];
          if (kind === undefined) continue;
          if (existing.has(`${instanceId}:${assignment.binding}`)) continue;
          const workload = publicWorkloadFor(plan, instanceId, kind.capability, kind.field);
          const resolvedWorkload =
            workload !== undefined &&
            Object.keys(runtimeSpecFor(workload)?.bindings ?? {}).includes(kind.workloadBinding)
              ? workload
              : undefined;
          const endpoint =
            resolvedWorkload === undefined
              ? undefined
              : publishedEndpointFor(
                  (yield* Ref.get(published)).get(instanceId),
                  resolvedWorkload,
                  kind.workloadBinding,
                );
          const instance = state.registry.instances.find((entry) => entry.id === instanceId);
          const lazy =
            instance?.intent === "started" &&
            instance.config.enabled !== false &&
            plan.activation[instanceId] === "lazy";
          if (endpoint === undefined && !lazy) continue;
          const listener = yield* (options.bindHost ?? bindHostListener)(
            assignment.address,
            assignment.port,
            kind.field,
          ).pipe(Effect.provideService(Scope.Scope, ownerScope));
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
                resolvedWorkload === undefined
                  ? undefined
                  : publishedEndpointFor(active, resolvedWorkload, kind.workloadBinding);
              if (activeEndpoint === undefined) {
                const activateInstance = yield* Ref.get(instanceActivator);
                if (activateInstance === undefined)
                  return yield* new GatewayActivationError({
                    message: `Service instance ${instanceId} is dormant`,
                  });
                yield* activateInstance(instanceId);
                const refreshed = (yield* Ref.get(published)).get(instanceId);
                activeEndpoint =
                  resolvedWorkload === undefined
                    ? undefined
                    : publishedEndpointFor(refreshed, resolvedWorkload, kind.workloadBinding);
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
                          resolvedWorkload === undefined
                            ? endpoint
                            : publishedEndpointFor(
                                current.get(instanceId),
                                resolvedWorkload,
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
                          resolvedWorkload === undefined
                            ? endpoint
                            : publishedEndpointFor(
                                current.get(instanceId),
                                resolvedWorkload,
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
      });
    const publish = (
      instanceId: ServiceInstanceId,
      publications: ReadonlyArray<RuntimeBindingPublication>,
    ): Effect.Effect<void, StackError> =>
      lock.withPermit(publishUnlocked(instanceId, publications));
    const armLazyIngress = (
      state: PersistedStackState,
      plan: ExecutionPlan,
    ): Effect.Effect<void, GatewayActivationError | StackError> =>
      lock.withPermit(
        Effect.gen(function* () {
          const apiEnabled =
            state.listeners.api?.enabled !== false &&
            plan.routes.some((route) => route.listener === "api" && route.protocol === "http");
          const desiredApi = state.ports.find(
            (entry) => entry.owner === "stack" && entry.binding === "api",
          );
          const existingApi = yield* Ref.get(apiGateway);
          if (
            existingApi !== undefined &&
            (!apiEnabled ||
              desiredApi === undefined ||
              existingApi.address !== desiredApi.address ||
              existingApi.port !== desiredApi.port)
          )
            yield* releaseSharedApi;
          const existingReservation = yield* Ref.get(apiReservation);
          const reservedApi = existingReservation?.reservation.assignments.api;
          if (
            existingReservation !== undefined &&
            (!apiEnabled ||
              desiredApi === undefined ||
              reservedApi === undefined ||
              reservedApi.address !== desiredApi.address ||
              reservedApi.port !== desiredApi.port)
          )
            yield* releaseSharedApi;
          if (
            apiEnabled &&
            (yield* Ref.get(apiGateway)) === undefined &&
            (yield* Ref.get(apiReservation)) === undefined
          ) {
            const reservationScope = Scope.forkUnsafe(ownerScope);
            const reservation = yield* coordinator
              .acquire(
                options.stackId,
                [
                  {
                    owner: "stack",
                    binding: "api",
                    listenerField: "api",
                    address: state.listeners.api?.address ?? "127.0.0.1",
                    port: state.listeners.api?.port ?? "automatic",
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
            yield* Ref.set(apiReservation, { reservation, scope: reservationScope });
          }
          const lazyInstanceIds = state.registry.instances
            .filter(
              (instance) =>
                instance.config.enabled !== false &&
                instance.intent === "started" &&
                plan.activation[instance.id] === "lazy",
            )
            .map((instance) => instance.id);
          const apiInstanceId = apiEnabled
            ? plan.routes.find(
                (route) =>
                  route.listener === "api" &&
                  route.protocol === "http" &&
                  route.instanceId !== undefined &&
                  state.registry.instances.some(
                    (instance) =>
                      instance.id === route.instanceId &&
                      instance.config.enabled !== false &&
                      instance.intent === "started",
                  ),
              )?.instanceId
            : undefined;
          const instancesToArm = [
            ...new Set(
              apiInstanceId === undefined ? lazyInstanceIds : [...lazyInstanceIds, apiInstanceId],
            ),
          ];
          yield* Ref.set(armSharedApi, true);
          yield* Effect.forEach(instancesToArm, (instanceId) => publishUnlocked(instanceId, []), {
            discard: true,
          }).pipe(Effect.ensuring(Ref.set(armSharedApi, false)));
        }),
      );
    const unpublishUnlocked = (
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
          const sharedApi = yield* Ref.get(apiGateway);
          if (sharedApi !== undefined && (yield* Ref.get(apiGatewayInstances)).has(instanceId)) {
            const remaining = new Set(yield* Ref.get(apiGatewayInstances));
            remaining.delete(instanceId);
            yield* Ref.set(apiGatewayInstances, remaining);
            const remainingRoutes = sharedApiRoutes.filter(
              (route) => !isGatewayProxyRoute(route) || route.instanceId !== instanceId,
            );
            sharedApiRoutes.splice(0, sharedApiRoutes.length, ...remainingRoutes);
            for (const [capability, routeInstanceId] of sharedApiRouteInstances)
              if (routeInstanceId === instanceId) sharedApiRouteInstances.delete(capability);
            if (remaining.size === 0) {
              sharedApiRoutes.splice(0, sharedApiRoutes.length);
              sharedApiRouteInstances.clear();
            }
          }
        }
        yield* Ref.update(published, (current) => {
          const next = new Map(current);
          next.delete(instanceId);
          return next;
        });
      });
    const unpublish = (
      instanceId: ServiceInstanceId,
      preserveListener = false,
    ): Effect.Effect<void, StackError> =>
      lock.withPermit(unpublishUnlocked(instanceId, preserveListener));
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
      Effect.all({
        gateways: Ref.get(instanceGateways),
        sharedApiInstances: Ref.get(apiGatewayInstances),
      }).pipe(
        Effect.map(
          ({ gateways, sharedApiInstances }) =>
            sharedApiInstances.has(instanceId) ||
            [...gateways.keys()].some((key) => key.startsWith(`${instanceId}:`)),
        ),
      );
    return {
      close,
      publish,
      armLazyIngress,
      unpublish,
      setInstanceActivator,
      setTrafficAcquirer,
      isInstanceWakeable,
    } satisfies SupervisorIngress;
  });
