/** Test-only runtime seams for building deterministic consumer layers. */
import { Effect, Stream } from "effect";
import type { StackInfo } from "./Stack.ts";
import type { Stack } from "./Stack.ts";
import { StackServiceState } from "./StackServiceState.ts";

const testStackInfo: StackInfo = {
  url: "http://127.0.0.1",
  dbUrl: "postgresql://127.0.0.1/postgres",
  publishableKey: "publishable",
  secretKey: "secret",
  anonJwt: "anon",
  serviceRoleJwt: "role",
  serviceEndpoints: {},
};

const testStackState = new StackServiceState({
  name: "auth",
  status: "Running",
  pid: null,
  exitCode: null,
  restartCount: 0,
  startedAt: null,
  error: null,
});

export const makeTestStack = (overrides: Partial<Stack["Service"]> = {}): Stack["Service"] => {
  const defaults: Stack["Service"] = {
    getInfo: () => Effect.succeed(testStackInfo),
    start: () => Effect.void,
    stop: () => Effect.void,
    dispose: () => Effect.void,
    startService: () => Effect.void,
    stopService: () => Effect.void,
    restartService: () => Effect.void,
    reloadFunctions: () => Effect.void,
    reloadEdgeRuntime: () => Effect.void,
    getState: () => Effect.succeed(testStackState),
    getAllStates: () => Effect.succeed([testStackState]),
    stateChanges: () => Effect.succeed(Stream.empty),
    allStateChanges: () => Stream.empty,
    waitReady: () => Effect.void,
    waitAllReady: () => Effect.void,
    subscribeLogs: () => Stream.empty,
    subscribeAllLogs: () => Stream.empty,
    logHistory: () => Effect.succeed([]),
    logHistoryAll: () => Effect.succeed([]),
  };
  return { ...defaults, ...overrides };
};

export { HttpTransportClient } from "./HttpTransportClient.ts";
export { makeSupervisorControlApplication } from "./SupervisorControlServer.ts";
export { SupervisorSession } from "./SupervisorSession.ts";
