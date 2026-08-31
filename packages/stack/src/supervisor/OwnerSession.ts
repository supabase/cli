import { Effect, FileSystem, Scope } from "effect";
import type { ControlEndpoint } from "../state/Ownership.ts";
import {
  startControlServer,
  type ControlServer,
  type MaintenanceHandlers,
} from "../control/ControlServer.ts";
import type { StackRpcHandlers } from "../control/StackRpc.ts";
import { StackRpcProtocolError } from "../control/StackRpc.ts";
import type { MaintenanceRequest } from "../control/MaintenanceProtocol.ts";

/** A bound owner session; ownership and metadata publication live in Launcher. */
export interface OwnerSession {
  readonly endpoint: ControlEndpoint;
  readonly ready: Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

export interface OwnerSessionOptions {
  readonly endpoint: ControlEndpoint;
  readonly stackId: string;
  readonly ownerSessionId: string;
  readonly rpcRelease?: string;
  readonly maintenanceHandlers: MaintenanceHandlers;
  /** Called after a stop/quiesce response is written and the connection closes. */
  readonly onMaintenanceComplete?: (op: MaintenanceRequest["op"]) => Effect.Effect<void>;
  /** Called after a successful destroy response is written. */
  readonly onDestroyResponse?: () => Effect.Effect<void>;
  readonly rpcHandlers: StackRpcHandlers;
}

/**
 * Bind the exact endpoint and run both control protocols. This function does
 * not acquire an ownership lock or write metadata; callers publish metadata
 * only after the returned `ready` effect completes.
 */
export const startOwnerSession = (
  options: OwnerSessionOptions,
): Effect.Effect<OwnerSession, StackRpcProtocolError, Scope.Scope | FileSystem.FileSystem> =>
  startControlServer(options).pipe(
    Effect.map((server: ControlServer) => ({
      endpoint: server.endpoint,
      ready: server.ready,
      shutdown: server.shutdown,
    })),
    Effect.mapError((error) => new StackRpcProtocolError({ message: error.message })),
  );
