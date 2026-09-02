import { Data, Effect, Exit } from "effect";
import { GatewayActivationError } from "../public/Errors.ts";
import type { CapabilityName } from "../public/Capability.ts";
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

export interface GatewayRouteRequest {
  readonly path: string;
  readonly method?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** A response produced locally without activating or resolving a backend. */
export interface GatewayLocalResponse {
  readonly status?: number;
  readonly body: string | Uint8Array;
  readonly contentType?: string;
}

type GatewayHeaderValue = string | string[];
export type GatewayHeaders = Readonly<Record<string, GatewayHeaderValue>>;
export type GatewayHeaderTransform = (
  request: GatewayRouteRequest,
  headers: GatewayHeaders,
) => GatewayHeaders;

export interface GatewayProxyRoute {
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
  /** Proxy routes never produce a local response. */
  readonly localResponse?: never;
}

/** HTTP-only route that produces a response without activating a capability. */
interface GatewayLocalRoute {
  readonly capability?: never;
  readonly binding?: never;
  readonly match: (request: GatewayRouteRequest) => boolean;
  readonly upstreamPath?: never;
  readonly upstreamHeaders?: never;
  readonly prepare?: never;
  readonly localResponse: (
    request: GatewayRouteRequest,
  ) => Effect.Effect<GatewayLocalResponse, GatewayRouteNotFoundError>;
}

export type GatewayRoute = GatewayProxyRoute | GatewayLocalRoute;

export const isGatewayProxyRoute = (route: GatewayRoute): route is GatewayProxyRoute =>
  route.capability !== undefined;

export interface StackGateway {
  readonly http: ReadonlyMap<PortField, HttpGateway>;
  readonly tcp: ReadonlyMap<PortField, TcpGateway>;
  readonly close: Effect.Effect<void>;
}

interface HttpGatewayListenerOptions {
  readonly field: PortField;
  readonly options: Omit<HttpGatewayOptions, "activate">;
}

interface TcpGatewayListenerOptions {
  readonly field: PortField;
  readonly options: Omit<TcpGatewayOptions, "activate">;
}

export interface StackGatewayOptions {
  readonly http?: ReadonlyArray<HttpGatewayListenerOptions>;
  readonly tcp?: ReadonlyArray<TcpGatewayListenerOptions>;
  readonly activate: (
    capability: CapabilityName,
  ) => Effect.Effect<ActivationResult, GatewayActivationError>;
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
