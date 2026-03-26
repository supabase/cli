import { LogBuffer, Orchestrator } from "@supabase/process-compose";
import { ServiceNotFoundError } from "@supabase/process-compose";
import type { LogEntry, ServiceReadyError } from "@supabase/process-compose";
import { Effect, Layer, Schema, ServiceMap, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { cleanupLocalStackResources } from "./cleanup.ts";
import { StackBuildError } from "./errors.ts";
import { changedProjectedStates, projectStackStates } from "./StackStateProjection.ts";
import { StackBuilder, type ResolvedStackConfig } from "./StackBuilder.ts";
import { type StackServiceState } from "./StackServiceState.ts";

export interface StackInfo {
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
  readonly dockerContainerNames: ReadonlyArray<string>;
  readonly serviceEndpoints: Readonly<Record<string, string>>;
}

export const StackInfoSchema = Schema.Struct({
  url: Schema.String,
  dbUrl: Schema.String,
  publishableKey: Schema.String,
  secretKey: Schema.String,
  anonJwt: Schema.String,
  serviceRoleJwt: Schema.String,
  dockerContainerNames: Schema.Array(Schema.String),
  serviceEndpoints: Schema.Record(Schema.String, Schema.String),
});

export type StackService = ServiceMap.Service.Shape<typeof Stack>;

export class Stack extends ServiceMap.Service<
  Stack,
  {
    readonly getInfo: () => Effect.Effect<StackInfo>;
    readonly start: () => Effect.Effect<void, ServiceReadyError>;
    readonly stop: () => Effect.Effect<void>;
    readonly dispose: () => Effect.Effect<void>;
    readonly startService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError>;
    readonly stopService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly restartService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly getState: (name: string) => Effect.Effect<StackServiceState, ServiceNotFoundError>;
    readonly getAllStates: () => Effect.Effect<ReadonlyArray<StackServiceState>>;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<Stream.Stream<StackServiceState>, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<StackServiceState>;
    readonly waitReady: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError>;
    readonly waitAllReady: () => Effect.Effect<void, ServiceReadyError>;
    readonly subscribeLogs: (name: string) => Stream.Stream<LogEntry>;
    readonly subscribeAllLogs: (services?: ReadonlyArray<string>) => Stream.Stream<LogEntry>;
    readonly logHistory: (name: string, limit?: number) => Effect.Effect<ReadonlyArray<LogEntry>>;
    readonly logHistoryAll: (
      limit?: number,
      services?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LogEntry>>;
  }
>()("stack/Stack") {
  static layer = (
    config: ResolvedStackConfig,
  ): Layer.Layer<Stack, StackBuildError, StackBuilder | ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const builder = yield* StackBuilder;
        const { graph, dockerContainerNames, serviceProjection } = yield* builder.build(config);

        // Get the current scope so sub-layers' scoped resources (FiberMap,
        // PubSub, etc.) stay alive for the lifetime of Stack.
        const scope = yield* Effect.scope;

        // Create LogBuffer within the current scope
        const logBufferServices = yield* Layer.buildWithScope(LogBuffer.layer, scope);
        const logBuffer = ServiceMap.get(logBufferServices, LogBuffer);

        // Build orchestrator within the current scope, with shared LogBuffer
        const orchLayer = Orchestrator.layer(graph).pipe(
          Layer.provide(Layer.succeed(LogBuffer, logBuffer)),
        );
        const orchServices = yield* Layer.buildWithScope(orchLayer, scope);
        const orchestrator = ServiceMap.get(orchServices, Orchestrator);

        const info: StackInfo = {
          url: `http://127.0.0.1:${config.apiPort}`,
          dbUrl: `postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/postgres`,
          publishableKey: config.publishableKey,
          secretKey: config.secretKey,
          anonJwt: config.anonJwt,
          serviceRoleJwt: config.serviceRoleJwt,
          dockerContainerNames,
          serviceEndpoints: {
            ...(config.auth === false ? {} : { auth: `http://127.0.0.1:${config.auth.port}` }),
            ...(config.postgrest === false
              ? {}
              : { postgrest: `http://127.0.0.1:${config.postgrest.port}` }),
            ...(config.realtime === false
              ? {}
              : { realtime: `http://127.0.0.1:${config.realtime.port}` }),
            ...(config.storage === false
              ? {}
              : {
                  storage: `http://127.0.0.1:${config.storage.port}`,
                  storage_s3: `http://127.0.0.1:${config.apiPort}/storage/v1/s3`,
                }),
            ...(config.imgproxy === false
              ? {}
              : { imgproxy: `http://127.0.0.1:${config.imgproxy.port}` }),
            ...(config.mailpit === false
              ? {}
              : {
                  mailpit: `http://127.0.0.1:${config.mailpit.port}`,
                  mailpit_smtp: `smtp://127.0.0.1:${config.mailpit.smtpPort}`,
                  mailpit_pop3: `pop3://127.0.0.1:${config.mailpit.pop3Port}`,
                }),
            ...(config.pgmeta === false
              ? {}
              : { pgmeta: `http://127.0.0.1:${config.pgmeta.port}` }),
            ...(config.studio === false
              ? {}
              : { studio: `http://127.0.0.1:${config.studio.port}` }),
            ...(config.analytics === false
              ? {}
              : { analytics: `http://127.0.0.1:${config.analytics.port}` }),
            ...(config.pooler === false
              ? {}
              : {
                  pooler: `postgresql://postgres:postgres@127.0.0.1:${config.pooler.port}/postgres`,
                  pooler_admin: `http://127.0.0.1:${config.pooler.apiPort}`,
                }),
          },
        };

        let disposed = false;
        const disposeOnce = () =>
          Effect.gen(function* () {
            if (disposed) return;
            disposed = true;
            yield* cleanupLocalStackResources({ stack, info, config });
          });

        const getProjectedStates = (): Effect.Effect<ReadonlyArray<StackServiceState>> =>
          Effect.map(orchestrator.getAllStates(), (states) =>
            projectStackStates(states, serviceProjection),
          );

        const projectedStateChanges = (): Stream.Stream<StackServiceState> =>
          Stream.unwrap(
            Effect.gen(function* () {
              const initialStates = yield* orchestrator.getAllStates();
              const initialProjected = projectStackStates(initialStates, serviceProjection);
              let rawStates = new Map(initialStates.map((state) => [state.name, state] as const));
              let projectedByName = new Map(
                initialProjected.map((state) => [state.name, state] as const),
              );

              return Stream.concat(
                Stream.fromIterable(initialProjected),
                orchestrator.allStateChanges().pipe(
                  Stream.map((rawState) => {
                    rawStates.set(rawState.name, rawState);
                    const nextProjected = projectStackStates(
                      [...rawStates.values()],
                      serviceProjection,
                    );
                    const changed = changedProjectedStates(projectedByName, nextProjected);
                    projectedByName = new Map(
                      nextProjected.map((state) => [state.name, state] as const),
                    );
                    return changed;
                  }),
                  Stream.flatMap((states) => Stream.fromIterable(states)),
                ),
              );
            }),
          );

        const stack: StackService = {
          getInfo: () => Effect.succeed(info),
          start: () =>
            Effect.gen(function* () {
              yield* orchestrator.start();
              yield* orchestrator.waitAllReady();
            }),
          stop: () => orchestrator.stop(),
          dispose: disposeOnce,
          startService: (name) =>
            Effect.gen(function* () {
              yield* orchestrator.startService(name);
              yield* orchestrator.waitReady(name);
            }),
          stopService: (name) => orchestrator.stopService(name),
          restartService: (name) => orchestrator.restartService(name),
          getState: (name) =>
            Effect.gen(function* () {
              const projected = yield* getProjectedStates();
              const match = projected.find((state) => state.name === name);
              if (match === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              return match;
            }),
          getAllStates: getProjectedStates,
          stateChanges: (name) =>
            Effect.gen(function* () {
              const projected = yield* getProjectedStates();
              if (!projected.some((state) => state.name === name)) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              return projectedStateChanges().pipe(Stream.filter((state) => state.name === name));
            }),
          allStateChanges: projectedStateChanges,
          waitReady: (name) => orchestrator.waitReady(name),
          waitAllReady: () => orchestrator.waitAllReady(),
          subscribeLogs: (name) => logBuffer.subscribe(name),
          subscribeAllLogs: (services) =>
            services === undefined || services.length === 0
              ? logBuffer.subscribeAll()
              : logBuffer
                  .subscribeAll()
                  .pipe(Stream.filter((entry) => services.includes(entry.service))),
          logHistory: (name, limit) => logBuffer.history(name, limit),
          logHistoryAll: (limit, services) => logBuffer.historyAll(limit, services),
        };

        yield* Effect.addFinalizer(disposeOnce);

        return stack;
      }),
    );
}
