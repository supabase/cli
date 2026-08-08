import { Clock, Effect, FileSystem, Layer, Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { parseLegacyConnectionString } from "../../../shared/legacy-db-config.parse.ts";
import { LegacyDbConnectError } from "../../../shared/legacy-db-connection.errors.ts";
import { legacyAcquirePgPool } from "../../../shared/legacy-db-connection.sql-pg.layer.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import {
  LegacyPgDeltaEngine,
  LegacyPgDeltaEngineError,
  type LegacyPgDeltaDatabaseEndpoint,
  type LegacyPgDeltaDiffResult,
  type LegacyPgDeltaEndpoint,
} from "./legacy-pgdelta-engine.service.ts";
import {
  LegacyPgDeltaNextAdapter,
  type LegacyPgDeltaNextOperation,
} from "./legacy-pgdelta-next-adapter.service.ts";
import {
  legacyFormatPgDeltaNextDebugId,
  legacySavePgDeltaNextDebugArtifacts,
  type LegacyPgDeltaNextDebugArtifacts,
} from "./legacy-pgdelta-next-artifacts.ts";
import { LegacyPgDeltaNextShadow } from "./legacy-pgdelta-next-shadow.service.ts";
import {
  legacyPgDeltaNextDiagnosticReport,
  legacyReportPgDeltaNextDiagnostics,
} from "./legacy-pgdelta-next-diagnostics.ts";

/** Shared by both declarative planner entrypoints over the full isolated baseline. */
export const legacyPgDeltaNextIsolatedShadowPlanOptions = {
  isolatedShadow: true,
  seedAssumedSchemas: false,
} as const;

function legacyPgDeltaNextConnectSuggestion(cause: unknown): string | undefined {
  if (cause instanceof LegacyDbConnectError) return cause.suggestion;
  if (typeof cause !== "object" || cause === null) return undefined;
  const nested = Reflect.get(cause, "cause");
  return nested === cause ? undefined : legacyPgDeltaNextConnectSuggestion(nested);
}

export const legacyPgDeltaNextEngineError = (cause: unknown) => {
  if (cause instanceof LegacyPgDeltaEngineError) return cause;
  const suggestion = legacyPgDeltaNextConnectSuggestion(cause);
  return new LegacyPgDeltaEngineError({
    message:
      typeof cause === "object" &&
      cause !== null &&
      typeof Reflect.get(cause, "message") === "string"
        ? String(Reflect.get(cause, "message"))
        : String(cause),
    cause,
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
};

function normalizeNextDiff(
  result: {
    readonly changes: boolean;
    readonly sql: string;
    readonly files: ReadonlyArray<{
      readonly sequence: number;
      readonly suffix: string | null;
      readonly sql: string;
      readonly transactionMode: "transactional" | "none";
      readonly actionCount: number;
    }>;
    readonly removals?: LegacyPgDeltaDiffResult["removals"];
    readonly debug?: {
      readonly sourceSnapshot?: string;
      readonly desiredSnapshot?: string;
      readonly plan?: string;
    };
  },
  debugDirectory?: string,
): LegacyPgDeltaDiffResult {
  return {
    changes: result.changes,
    sql: result.sql,
    files: result.files.map((file) => ({
      sequence: file.sequence,
      name: `segment_${file.sequence}`,
      suffix: file.suffix,
      sql: file.sql,
      transactionMode: file.transactionMode,
      actionCount: file.actionCount,
    })),
    ...(result.removals !== undefined ? { removals: result.removals } : {}),
    ...(result.debug !== undefined
      ? {
          debug: {
            ...result.debug,
            ...(debugDirectory !== undefined ? { directory: debugDirectory } : {}),
          },
        }
      : {}),
  };
}

function parseEndpoint(endpoint: LegacyPgDeltaDatabaseEndpoint) {
  if (endpoint.connection !== undefined) return endpoint.connection;
  const parsed = parseLegacyConnectionString(endpoint.ref);
  if (parsed !== undefined) return parsed;
  throw new LegacyPgDeltaEngineError({
    message: "failed to parse Postgres connection string for pg-delta",
    cause: endpoint.ref.replace(/:[^:@/]+@/, ":***@"),
  });
}

/** In-process pg-delta next implementation. Every pool and shadow is scope-owned. */
export const legacyPgDeltaNextEngineLayer = Layer.effect(
  LegacyPgDeltaEngine,
  Effect.gen(function* () {
    const adapter = yield* LegacyPgDeltaNextAdapter;
    const shadowService = yield* LegacyPgDeltaNextShadow;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const debugLogger = yield* LegacyDebugLogger;
    const output = yield* Output;
    let feedbackInvitationShown = false;

    const saveDebugArtifacts = (
      workdir: string,
      operation: LegacyPgDeltaNextOperation,
      artifacts: LegacyPgDeltaNextDebugArtifacts,
    ) =>
      Effect.gen(function* () {
        const id = legacyFormatPgDeltaNextDebugId(yield* Clock.currentTimeMillis, operation);
        const debugDir = yield* legacySavePgDeltaNextDebugArtifacts(
          fs,
          path,
          workdir,
          id,
          operation,
          artifacts,
        );
        yield* debugLogger.debug(`Saved pg-delta next debug artifacts to ${debugDir}.`);
        return debugDir;
      }).pipe(
        Effect.catch((cause) =>
          debugLogger
            .debug(
              `Failed to save pg-delta next debug artifacts: ${
                typeof cause === "object" &&
                cause !== null &&
                typeof Reflect.get(cause, "message") === "string"
                  ? String(Reflect.get(cause, "message"))
                  : String(cause)
              }`,
            )
            .pipe(Effect.as(undefined)),
        ),
      );

    const acquireDatabase = (endpoint: LegacyPgDeltaDatabaseEndpoint) =>
      legacyAcquirePgPool(parseEndpoint(endpoint), endpoint.connectOptions);

    const reportDiagnostics = (
      operation: LegacyPgDeltaNextOperation,
      diagnostics: Parameters<typeof legacyReportPgDeltaNextDiagnostics>[1],
      strictCoverage: boolean,
    ) => {
      const report = legacyPgDeltaNextDiagnosticReport(diagnostics, strictCoverage);
      const showFeedback = !feedbackInvitationShown && report.unmodeledKinds.length > 0;
      if (showFeedback) feedbackInvitationShown = true;
      return legacyReportPgDeltaNextDiagnostics(
        operation,
        diagnostics,
        strictCoverage,
        showFeedback,
      ).pipe(Effect.provideService(Output, output));
    };

    return LegacyPgDeltaEngine.of({
      implementation: "next",
      diffExplicit: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            let shadow:
              | { readonly migrationsUrl: string; readonly declarativeUrl: string }
              | undefined;
            const migrationsEndpoint =
              input.source.kind === "migrations"
                ? input.source
                : input.desired.kind === "migrations"
                  ? input.desired
                  : undefined;
            if (migrationsEndpoint !== undefined) {
              shadow = yield* shadowService.provision({
                schema: input.schema,
                ...(migrationsEndpoint.projectRef !== undefined
                  ? { projectRef: migrationsEndpoint.projectRef }
                  : {}),
              });
            }
            const endpointPool = (endpoint: LegacyPgDeltaEndpoint) =>
              Effect.gen(function* () {
                if (endpoint.kind === "database") return yield* acquireDatabase(endpoint);
                if (shadow === undefined) {
                  return yield* Effect.die("missing pg-delta migrations shadow");
                }
                const connection = parseLegacyConnectionString(shadow.migrationsUrl);
                if (connection === undefined) {
                  return yield* Effect.fail(
                    new LegacyPgDeltaEngineError({
                      message: "failed to parse pg-delta migrations shadow URL",
                      cause: shadow.migrationsUrl.replace(/:[^:@/]+@/, ":***@"),
                    }),
                  );
                }
                return yield* legacyAcquirePgPool(connection, {
                  isLocal: true,
                  dnsResolver: "native",
                });
              });
            const [sourcePool, desiredPool] = yield* Effect.all(
              [endpointPool(input.source), endpointPool(input.desired)],
              { concurrency: 2 },
            );
            const result = yield* adapter.diff({
              sourcePool,
              desiredPool,
              allowDrops: true,
              debug: input.debug,
              schema: input.schema,
              formatOptions: input.formatOptions,
            });
            const debugDirectory =
              result.debug !== undefined
                ? yield* saveDebugArtifacts(input.context.cwd, "diff", {
                    ...result.debug,
                    diagnostics: result.diagnostics,
                  })
                : undefined;
            yield* reportDiagnostics("diff", result.diagnostics, input.strictCoverage);
            return normalizeNextDiff(result, debugDirectory);
          }),
        ).pipe(Effect.mapError(legacyPgDeltaNextEngineError)),
      diffDatabase: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const shadow = yield* shadowService.provision({
              schema: input.schema,
              ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
            });
            const migrations = parseLegacyConnectionString(shadow.migrationsUrl);
            if (migrations === undefined) {
              return yield* Effect.fail(
                new LegacyPgDeltaEngineError({
                  message: "failed to parse pg-delta next shadow database URL",
                  cause: "invalid password-free shadow output",
                }),
              );
            }
            const migrationsPool = yield* legacyAcquirePgPool(migrations, {
              isLocal: true,
              dnsResolver: "native",
            });
            const desiredPool = yield* acquireDatabase(input.target);
            const result = yield* adapter.diff({
              sourcePool: migrationsPool,
              desiredPool,
              allowDrops: true,
              debug: input.debug,
              schema: input.schema,
              formatOptions: input.formatOptions,
            });
            const debugDirectory =
              result.debug !== undefined
                ? yield* saveDebugArtifacts(input.context.cwd, "diff", {
                    ...result.debug,
                    diagnostics: result.diagnostics,
                  })
                : undefined;
            yield* reportDiagnostics("diff", result.diagnostics, input.strictCoverage);
            return normalizeNextDiff(result, debugDirectory);
          }),
        ).pipe(Effect.mapError(legacyPgDeltaNextEngineError)),
      exportDeclarativeSchema: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* acquireDatabase(input.target);
            const result = yield* adapter.exportDeclarativeSchema({
              pool,
              layout: "grouped",
              schema: input.schema,
              formatOptions: input.formatOptions,
            });
            if (input.debug) {
              const capture = yield* adapter
                .captureSnapshot({ pool, redactSecrets: true })
                .pipe(Effect.orElseSucceed(() => undefined));
              yield* saveDebugArtifacts(input.context.cwd, "declarativeExport", {
                ...(capture !== undefined ? { desiredSnapshot: capture.snapshot } : {}),
                diagnostics:
                  capture === undefined
                    ? result.diagnostics
                    : [...result.diagnostics, ...capture.diagnostics],
              });
            }
            yield* reportDiagnostics("declarativeExport", result.diagnostics, input.strictCoverage);
            return { files: result.files, manifest: result.manifest };
          }),
        ).pipe(Effect.mapError(legacyPgDeltaNextEngineError)),
      planDeclarativeSchema: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const shadow = yield* shadowService.provision({ schema: input.schema });
            const migrations = parseLegacyConnectionString(shadow.migrationsUrl);
            const declarative = parseLegacyConnectionString(shadow.declarativeUrl);
            if (migrations === undefined || declarative === undefined) {
              return yield* Effect.fail(
                new LegacyPgDeltaEngineError({
                  message: "failed to parse pg-delta next shadow database URL",
                  cause: "invalid password-free shadow output",
                }),
              );
            }
            const [migrationsPool, declarativePool] = yield* Effect.all(
              [
                legacyAcquirePgPool(migrations, { isLocal: true, dnsResolver: "native" }),
                legacyAcquirePgPool(declarative, { isLocal: true, dnsResolver: "native" }),
              ],
              { concurrency: 2 },
            );
            const result = yield* adapter.planDeclarativeSchema({
              targetPool: migrationsPool,
              shadowPool: declarativePool,
              files: input.files,
              allowDrops: true,
              debug: input.debug,
              reorder: true,
              ...legacyPgDeltaNextIsolatedShadowPlanOptions,
              schema: input.schema,
              formatOptions: input.formatOptions,
              ...(input.manifest !== undefined ? { manifest: input.manifest } : {}),
            });
            const debugDirectory =
              result.debug !== undefined
                ? yield* saveDebugArtifacts(input.context.cwd, "declarativePlan", {
                    ...result.debug,
                    diagnostics: result.diagnostics,
                  })
                : undefined;
            yield* reportDiagnostics("declarativePlan", result.diagnostics, input.strictCoverage);
            return {
              ...normalizeNextDiff(result, debugDirectory),
              sourceRef: "pg-delta-next:migrations",
              targetRef: "pg-delta-next:declarative",
            };
          }),
        ).pipe(Effect.mapError(legacyPgDeltaNextEngineError)),
    });
  }),
);
