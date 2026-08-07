import { Effect, FileSystem, Layer, Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyFindDropStatements } from "../../../shared/legacy-sql-split.ts";
import {
  LegacyPgDeltaEngine,
  LegacyPgDeltaEngineError,
  type LegacyPgDeltaDiffResult,
  type LegacyPgDeltaEndpoint,
  type LegacyPgDeltaTransactionMode,
} from "./legacy-pgdelta-engine.service.ts";
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
      readonly transactionMode: LegacyPgDeltaTransactionMode;
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

    const provideRuntime = <Success, Error>(
      operation: Effect.Effect<
        Success,
        Error,
        | LegacyDeclarativeSeam
        | LegacyEdgeRuntimeScript
        | LegacyPgDeltaSslProbe
        | FileSystem.FileSystem
        | Output
        | Path.Path
      >,
    ) =>
      operation.pipe(
        Effect.provideService(LegacyEdgeRuntimeScript, edgeRuntime),
        Effect.provideService(LegacyPgDeltaSslProbe, sslProbe),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(LegacyDeclarativeSeam, seam),
        Effect.provideService(Output, output),
      );

    const endpointRef = (context: LegacyPgDeltaContext, endpoint: LegacyPgDeltaEndpoint) =>
      endpoint.kind === "database"
        ? Effect.succeed(endpoint.ref)
        : legacyResolveMigrationsCatalogRef(
            fs,
            path,
            context,
            endpoint.projectRef !== undefined ? { projectRef: endpoint.projectRef } : {},
          ).pipe(provideRuntime);

    return LegacyPgDeltaEngine.of({
      implementation: "legacy",
      diffExplicit: (input) =>
        Effect.gen(function* () {
          const sourceRef = yield* endpointRef(input.context, input.source);
          const targetRef = yield* endpointRef(input.context, input.desired);
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
          const shadow = yield* seam.provisionShadow({
            mode: "diff",
            schema: input.schema,
            ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
          });
          const sourceSnapshot = input.debug
            ? yield* provideRuntime(
                legacyExportCatalogPgDelta(input.context, {
                  targetRef: shadow.sourceUrl,
                  role: "postgres",
                }),
              ).pipe(Effect.orElseSucceed(() => undefined))
            : undefined;
          return yield* provideRuntime(
            legacyDiffPgDelta(input.context, {
              sourceRef: shadow.sourceUrl,
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
            Effect.ensuring(seam.removeShadowContainer(shadow.container)),
          );
        }).pipe(Effect.mapError(mapError)),
      exportDeclarativeSchema: (input) =>
        Effect.gen(function* () {
          const baselineRef = yield* seam.exportCatalog({
            mode: "baseline",
            noCache: input.noCache,
            ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
          });
          const result = yield* provideRuntime(
            legacyDeclarativeExportPgDelta(input.context, {
              sourceRef: baselineRef,
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
