import { Effect, FileSystem, Layer, Path } from "effect";

import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyFindDropStatements } from "../../../shared/legacy-sql-split.ts";
import {
  LegacyPgDeltaEngine,
  LegacyPgDeltaEngineError,
  type LegacyPgDeltaDiffResult,
  type LegacyPgDeltaEndpoint,
} from "./legacy-pgdelta-engine.service.ts";
import {
  legacyDeclarativeExportPgDelta,
  legacyDiffPgDelta,
  legacyExportCatalogPgDelta,
} from "./legacy-pgdelta.ts";
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
      readonly transactionMode: string;
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
      transactional: file.transactionMode !== "non-transactional",
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

    const provideRuntime = <Success, Error>(
      operation: Effect.Effect<
        Success,
        Error,
        LegacyEdgeRuntimeScript | LegacyPgDeltaSslProbe | FileSystem.FileSystem | Path.Path
      >,
    ) =>
      operation.pipe(
        Effect.provideService(LegacyEdgeRuntimeScript, edgeRuntime),
        Effect.provideService(LegacyPgDeltaSslProbe, sslProbe),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    const endpointRef = (endpoint: LegacyPgDeltaEndpoint, noCache: boolean) =>
      endpoint.kind === "database"
        ? Effect.succeed(endpoint.ref)
        : seam.exportCatalog({
            mode: "migrations",
            noCache,
            ...(endpoint.projectRef !== undefined ? { projectRef: endpoint.projectRef } : {}),
          });

    return LegacyPgDeltaEngine.of({
      implementation: "legacy",
      diffExplicit: (input) =>
        Effect.gen(function* () {
          const sourceRef = yield* endpointRef(input.source, false);
          const targetRef = yield* endpointRef(input.desired, false);
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
            targetLocal: input.targetLocal,
            usePgDelta: true,
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
              targetRef: shadow.targetUrlOverride ?? input.target.ref,
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
          const sourceRef = yield* seam.exportCatalog({
            mode: "migrations",
            noCache: input.noCache,
          });
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
