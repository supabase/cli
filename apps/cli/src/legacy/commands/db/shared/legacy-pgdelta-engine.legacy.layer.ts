import { Effect, FileSystem, Layer, Path } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import type { LegacyDbTomlValues } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyFindDropStatements } from "../../../shared/legacy-sql-split.ts";
import {
  LegacyPgDeltaEngine,
  LegacyPgDeltaEngineError,
  type LegacyPgDeltaDiffResult,
  type LegacyPgDeltaEndpoint,
} from "./legacy-pgdelta-engine.service.ts";
import type { LegacyMigrationTransactionMode } from "../../../shared/legacy-migration-file.ts";
import {
  type LegacyPgDeltaContext,
  legacyDeclarativeExportPgDelta,
  legacyDiffPgDelta,
  legacyExportCatalogPgDelta,
} from "../../../shared/legacy-pgdelta.ts";
import {
  legacyGetMigrationsCatalogRef,
  legacyResolveMigrationsCatalogRef,
} from "../../../shared/legacy-pgdelta.cache.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

const mapError = (cause: { readonly message: string }) =>
  new LegacyPgDeltaEngineError({ message: cause.message, cause });

function normalizeDiff(
  result: {
    readonly sql: string;
    readonly stderr: string;
    readonly files: ReadonlyArray<{
      readonly order: number;
      readonly name: string;
      readonly transactionMode: LegacyMigrationTransactionMode;
      readonly sql: string;
    }>;
  },
  debug: boolean,
): LegacyPgDeltaDiffResult {
  return {
    changes: result.sql.trim().length > 0,
    sql: result.sql,
    files: result.files.map((file) => ({
      sequence: file.order,
      name: file.name,
      sql: file.sql,
      transactionMode: file.transactionMode,
    })),
    ...(debug ? { debug: { stderr: result.stderr } } : {}),
  };
}

/** Behavior-preserving adapter for the alpha.33 edge-runtime implementation. */
export const legacyPgDeltaLegacyEngineLayer = Layer.effect(
  LegacyPgDeltaEngine,
  Effect.gen(function* () {
    const edgeRuntime = yield* LegacyEdgeRuntimeScript;
    const sslProbe = yield* LegacyPgDeltaSslProbe;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seam = yield* LegacyDeclarativeSeam;
    const output = yield* Output;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const dbConnection = yield* LegacyDbConnection;
    const docker = yield* LegacyDockerRun;
    const httpClient = yield* HttpClient.HttpClient;
    const cliArgs = yield* CliArgs;
    const debugFlag = yield* LegacyDebugFlag;
    const experimentalFlag = yield* LegacyExperimentalFlag;
    const networkIdFlag = yield* LegacyNetworkIdFlag;

    const runtime = Layer.mergeAll(
      Layer.succeed(LegacyEdgeRuntimeScript, edgeRuntime),
      Layer.succeed(LegacyPgDeltaSslProbe, sslProbe),
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(Path.Path, path),
      Layer.succeed(LegacyDeclarativeSeam, seam),
      Layer.succeed(Output, output),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(RuntimeInfo, runtimeInfo),
      Layer.succeed(LegacyDbConnection, dbConnection),
      Layer.succeed(LegacyDockerRun, docker),
      Layer.succeed(HttpClient.HttpClient, httpClient),
      Layer.succeed(CliArgs, cliArgs),
      Layer.succeed(LegacyDebugFlag, debugFlag),
      Layer.succeed(LegacyExperimentalFlag, experimentalFlag),
      Layer.succeed(LegacyNetworkIdFlag, networkIdFlag),
    );

    const provideRuntime = <Success, Error, Requirements>(
      operation: Effect.Effect<Success, Error, Requirements>,
    ) => operation.pipe(Effect.provide(runtime));

    const endpointRef = (
      context: LegacyPgDeltaContext,
      endpoint: LegacyPgDeltaEndpoint,
      toml: LegacyDbTomlValues | undefined,
    ) =>
      endpoint.kind === "database"
        ? Effect.succeed(endpoint.ref)
        : toml === undefined
          ? Effect.fail(
              new LegacyPgDeltaEngineError({
                message: "pg-delta migrations endpoint requires loaded database config",
                cause: "missing database config",
              }),
            )
          : legacyResolveMigrationsCatalogRef(
              fs,
              path,
              context,
              toml,
              endpoint.projectRef !== undefined ? { projectRef: endpoint.projectRef } : {},
            ).pipe(provideRuntime);

    return LegacyPgDeltaEngine.of({
      implementation: "legacy",
      diffExplicit: (input) =>
        Effect.gen(function* () {
          const sourceRef = yield* endpointRef(input.context, input.source, input.toml);
          const targetRef = yield* endpointRef(input.context, input.desired, input.toml);
          const result = yield* provideRuntime(
            legacyDiffPgDelta(input.context, {
              sourceRef,
              targetRef,
              schema: input.schema,
              formatOptions: input.formatOptions,
            }),
          );
          return normalizeDiff(result, input.debug);
        }).pipe(Effect.mapError(mapError)),
      diffDatabase: (input) =>
        Effect.gen(function* () {
          const sourceSnapshot = input.debug
            ? yield* provideRuntime(
                legacyExportCatalogPgDelta(input.context, {
                  targetRef: input.source.ref,
                  role: "postgres",
                }),
              ).pipe(Effect.orElseSucceed(() => undefined))
            : undefined;
          return yield* provideRuntime(
            legacyDiffPgDelta(input.context, {
              sourceRef: input.source.ref,
              targetRef: input.target.ref,
              schema: input.schema,
              formatOptions: input.formatOptions,
            }),
          ).pipe(
            Effect.map((result) => {
              const normalized = normalizeDiff(result, input.debug);
              return input.debug
                ? {
                    ...normalized,
                    debug: {
                      ...(sourceSnapshot !== undefined ? { sourceSnapshot } : {}),
                      stderr: result.stderr,
                    },
                  }
                : normalized;
            }),
          );
        }).pipe(Effect.mapError(mapError)),
      exportDeclarativeSchema: (input) =>
        Effect.gen(function* () {
          if (input.source === undefined) {
            return yield* Effect.fail(
              new LegacyPgDeltaEngineError({
                message: "legacy pg-delta declarative export requires an empty shadow database",
                cause: "missing declarative export source",
              }),
            );
          }
          const result = yield* provideRuntime(
            legacyDeclarativeExportPgDelta(input.context, {
              sourceRef: input.source.ref,
              targetRef: input.target.ref,
              schema: input.schema,
              formatOptions: input.formatOptions,
            }),
          );
          return {
            files: result.files.map((file) => ({ name: file.path, sql: file.sql })),
          };
        }).pipe(Effect.mapError(mapError)),
      planDeclarativeSchema: (input) =>
        Effect.gen(function* () {
          const sourceRef = yield* legacyGetMigrationsCatalogRef(
            fs,
            path,
            input.context,
            input.toml,
            input.setupInputs,
            {
              noCache: input.noCache,
              ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
            },
          ).pipe(provideRuntime);
          const targetRef = yield* seam.exportCatalog({
            mode: "declarative",
            noCache: input.noCache,
          });
          const result = yield* provideRuntime(
            legacyDiffPgDelta(input.context, {
              sourceRef,
              targetRef,
              schema: input.schema,
              formatOptions: input.formatOptions,
            }),
          );
          return {
            ...normalizeDiff(result, input.debug),
            sourceRef,
            targetRef,
            dropWarnings: legacyFindDropStatements(result.sql),
          };
        }).pipe(Effect.mapError(mapError)),
    });
  }),
);
