import type { LogEntry } from "@supabase/process-compose";
import { Effect, Stream } from "effect";
import type { FunctionsReloadConfig } from "./functions.ts";
import type { ForegroundStackHandle } from "./createStack.ts";
import type { EdgeRuntimeReloadConfig } from "./Stack.ts";
import type { ReadyOptions } from "./StackConfig.ts";
import type { StackServiceState } from "./StackServiceState.ts";

/** Public Promise/AsyncIterable stack surface for Node and Bun consumers. */
export interface StackHandle extends AsyncDisposable {
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  startService(name: string): Promise<void>;
  stopService(name: string): Promise<void>;
  restartService(name: string): Promise<void>;
  reloadFunctions(opts?: FunctionsReloadConfig): Promise<void>;
  reloadEdgeRuntime(opts: EdgeRuntimeReloadConfig): Promise<void>;
  ready(opts?: ReadyOptions): Promise<void>;
  serviceReady(name: string, opts?: ReadyOptions): Promise<void>;
  getStatus(): Promise<ReadonlyArray<StackServiceState>>;
  getServiceStatus(name: string): Promise<StackServiceState>;
  statusChanges(): AsyncIterable<StackServiceState>;
  logs(): AsyncIterable<LogEntry>;
  serviceLogs(name: string): AsyncIterable<LogEntry>;
  logHistory(name: string, limit?: number): Promise<ReadonlyArray<LogEntry>>;
}

export const toStackHandle = (handle: ForegroundStackHandle): StackHandle => ({
  url: handle.url,
  dbUrl: handle.dbUrl,
  publishableKey: handle.publishableKey,
  secretKey: handle.secretKey,
  start: () => Effect.runPromise(handle.start()),
  stop: () => Effect.runPromise(handle.stop()),
  dispose: () => Effect.runPromise(handle.dispose()),
  startService: (name) => Effect.runPromise(handle.startService(name)),
  stopService: (name) => Effect.runPromise(handle.stopService(name)),
  restartService: (name) => Effect.runPromise(handle.restartService(name)),
  reloadFunctions: (opts) => Effect.runPromise(handle.reloadFunctions(opts)),
  reloadEdgeRuntime: (opts) => Effect.runPromise(handle.reloadEdgeRuntime(opts)),
  ready: (opts) => Effect.runPromise(handle.ready(opts)),
  serviceReady: (name, opts) => Effect.runPromise(handle.serviceReady(name, opts)),
  getStatus: () => Effect.runPromise(handle.getStatus()),
  getServiceStatus: (name) => Effect.runPromise(handle.getServiceStatus(name)),
  statusChanges: () => Stream.toAsyncIterable(handle.statusChanges()),
  logs: () => Stream.toAsyncIterable(handle.logs()),
  serviceLogs: (name) => Stream.toAsyncIterable(handle.serviceLogs(name)),
  logHistory: (name, limit) => Effect.runPromise(handle.logHistory(name, limit)),
  [Symbol.asyncDispose]: () => Effect.runPromise(handle.dispose()),
});
