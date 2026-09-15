import { Match, type Cause, type Deferred, type Exit, type Fiber } from "effect";
import type { ActivationResult, BackendEndpoint } from "../gateway/Gateway.ts";
import type { GatewayActivationError, StackError } from "../public/Errors.ts";

type EndpointState =
  | { readonly _tag: "unresolved" }
  | {
      readonly _tag: "resolving";
      readonly deferred: Deferred.Deferred<
        Exit.Exit<BackendEndpoint, GatewayActivationError | StackError>,
        never
      >;
    }
  | { readonly _tag: "resolved"; readonly endpoint: BackendEndpoint };

type Retirement =
  | { readonly _tag: "disarmed" }
  | {
      readonly _tag: "armed";
      readonly epoch: symbol;
      readonly fiber: Fiber.Fiber<void, unknown>;
    };

type ActivationCompletion = Deferred.Deferred<Exit.Exit<ActivationResult, StackError>, never>;

type WorkloadCompletion = Deferred.Deferred<Exit.Exit<void, StackError>, never>;

type StartingCompletion =
  | { readonly _tag: "activation"; readonly deferred: ActivationCompletion }
  | { readonly _tag: "workload"; readonly deferred: WorkloadCompletion };

export type CapabilityState =
  | { readonly _tag: "disabled" }
  | { readonly _tag: "stopped" }
  | {
      readonly _tag: "dormant";
      readonly sessionId: symbol;
      readonly traffic: number;
      readonly root: boolean;
      readonly retirement: { readonly _tag: "disarmed" };
    }
  | {
      readonly _tag: "starting";
      readonly sessionId: symbol;
      readonly traffic: number;
      readonly operation: symbol;
      readonly completion: StartingCompletion;
      readonly prior: Extract<CapabilityState, { readonly _tag: "dormant" | "ready" }>;
      readonly root: boolean;
      readonly retirement: { readonly _tag: "disarmed" };
    }
  | {
      readonly _tag: "ready";
      readonly sessionId: symbol;
      readonly traffic: number;
      readonly endpoint: EndpointState;
      readonly root: boolean;
      readonly retirement: Retirement;
    }
  | {
      readonly _tag: "stopping";
      readonly sessionId: symbol;
      readonly traffic: number;
      readonly operation: symbol;
      readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
      readonly prior: Extract<
        CapabilityState,
        { readonly _tag: "dormant" | "ready" | "cleanup-failed" }
      >;
      readonly root: boolean;
      readonly retirement: { readonly _tag: "disarmed" };
    }
  | {
      readonly _tag: "cleanup-failed";
      readonly sessionId: symbol;
      readonly traffic: number;
      readonly cause: Cause.Cause<StackError>;
      readonly root: boolean;
    };

type DormantState = Extract<CapabilityState, { readonly _tag: "dormant" }>;
type ReadyState = Extract<CapabilityState, { readonly _tag: "ready" }>;
type StartingState = Extract<CapabilityState, { readonly _tag: "starting" }>;
type StoppingState = Extract<CapabilityState, { readonly _tag: "stopping" }>;
type CleanupFailedState = Extract<CapabilityState, { readonly _tag: "cleanup-failed" }>;

export const dormant = (sessionId: symbol, traffic = 0, root = false): DormantState => ({
  _tag: "dormant",
  sessionId,
  traffic,
  root,
  retirement: { _tag: "disarmed" },
});

export const beginStarting = (
  prior: DormantState | ReadyState,
  operation: symbol,
  completion: StartingCompletion,
  root = prior.root,
): StartingState => ({
  _tag: "starting",
  sessionId: prior.sessionId,
  traffic: prior.traffic,
  operation,
  completion,
  prior,
  root,
  retirement: { _tag: "disarmed" },
});

export const ready = (
  sessionId: symbol,
  traffic: number,
  root: boolean,
  endpoint: EndpointState = { _tag: "unresolved" },
): ReadyState => ({
  _tag: "ready",
  sessionId,
  traffic,
  endpoint,
  root,
  retirement: { _tag: "disarmed" },
});

export const completeStarting = (
  state: StartingState,
  endpoint: EndpointState = { _tag: "unresolved" },
  root = state.root,
): ReadyState => ready(state.sessionId, state.traffic, root, endpoint);

export const restoreStarting = (state: StartingState): DormantState | ReadyState =>
  Match.value(state.prior).pipe(
    Match.tag("dormant", (prior) => dormant(prior.sessionId, state.traffic, prior.root)),
    Match.tag("ready", (prior) =>
      ready(prior.sessionId, state.traffic, prior.root, prior.endpoint),
    ),
    Match.exhaustive,
  );

export const promoteStartingPrior = (state: StartingState): StartingState => ({
  ...state,
  prior: Match.value(state.prior).pipe(
    Match.tag("dormant", (prior) => ready(prior.sessionId, state.traffic, prior.root)),
    Match.tag("ready", (prior) =>
      ready(prior.sessionId, state.traffic, prior.root, prior.endpoint),
    ),
    Match.exhaustive,
  ),
});

export const dormantFromReady = (state: ReadyState): DormantState =>
  dormant(state.sessionId, state.traffic, state.root);

export const beginStopping = (
  prior: DormantState | ReadyState | CleanupFailedState,
  operation: symbol,
  completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>,
  root = prior.root,
): StoppingState => ({
  _tag: "stopping",
  sessionId: prior.sessionId,
  traffic: prior.traffic,
  operation,
  completion,
  prior,
  root,
  retirement: { _tag: "disarmed" },
});

export const cleanupFailed = (
  state: StartingState | StoppingState | ReadyState,
  cause: Cause.Cause<StackError>,
): CapabilityState => ({
  _tag: "cleanup-failed",
  sessionId: state.sessionId,
  traffic: state.traffic,
  cause,
  root: state.root,
});

export const publicCapabilityState = (
  state: CapabilityState,
): "disabled" | "stopped" | "dormant" | "starting" | "ready" | "stopping" | "failed" =>
  Match.value(state).pipe(
    Match.when({ _tag: "disabled" }, () => "disabled" as const),
    Match.when({ _tag: "stopped" }, () => "stopped" as const),
    Match.when({ _tag: "dormant" }, () => "dormant" as const),
    Match.when({ _tag: "starting" }, () => "starting" as const),
    Match.when({ _tag: "ready" }, () => "ready" as const),
    Match.when({ _tag: "stopping" }, () => "stopping" as const),
    Match.when({ _tag: "cleanup-failed" }, () => "failed" as const),
    Match.exhaustive,
  );
