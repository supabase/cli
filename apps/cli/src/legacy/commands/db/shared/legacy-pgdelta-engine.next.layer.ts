import { Clock, Effect, FileSystem, Layer, Path } from "effect";
import type { Pool } from "pg";

import {
  filesForDeclarativeShadowLoad,
  prepareDeclarativeShadow,
} from "../../../../shared/schema/prepare-declarative-shadow.ts";
import { SchemaEngineError } from "../../../../shared/schema/schema-errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  legacyLayeredParseEnv,
  parseLegacyConnectionString,
  redactLegacyConnectionString,
} from "../../../shared/legacy-db-config.parse.ts";
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
  LegacyPgDeltaNextError,
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

function legacyPgDeltaNextConnectSuggestion(cause: unknown): string | undefined {
  if (cause instanceof LegacyDbConnectError) return cause.suggestion;
  if (typeof cause !== "object" || cause === null) return undefined;
  const nested = Reflect.get(cause, "cause");
  return nested === cause ? undefined : legacyPgDeltaNextConnectSuggestion(nested);
}

export const legacyPgDeltaNextEngineError = (cause: unknown) => {
  if (cause instanceof LegacyPgDeltaEngineError) return cause;
  const suggestion =
    legacyPgDeltaNextConnectSuggestion(cause) ??
    (cause instanceof SchemaEngineError ? cause.suggestion : undefined);
  const diagnostics = cause instanceof LegacyPgDeltaNextError ? cause.diagnostics : undefined;
  return new LegacyPgDeltaEngineError({
    message:
      typeof cause === "object" &&
      cause !== null &&
      typeof Reflect.get(cause, "message") === "string"
        ? String(Reflect.get(cause, "message"))
        : String(cause),
    cause,
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
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
    readonly hazards: NonNullable<LegacyPgDeltaDiffResult["hazards"]>;
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
    hazards: result.hazards,
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

export function legacyParsePgDeltaNextEndpoint(
  endpoint: LegacyPgDeltaDatabaseEndpoint,
  projectEnv: Readonly<Record<string, string>>,
) {
  return Effect.gen(function* () {
    if (endpoint.connection !== undefined) return endpoint.connection;
    const parsed = parseLegacyConnectionString(endpoint.ref, legacyLayeredParseEnv(projectEnv));
    if (parsed !== undefined) return parsed;
    return yield* Effect.fail(
      new LegacyPgDeltaEngineError({
        message: "failed to parse Postgres connection string for pg-delta",
        // `redactLegacyConnectionString`, not a local `:password@` regex: the input
        // reaching here is by definition unparseable, and a hand-typed password
        // containing `/`, `@`, or `:` defeats a naive single-character-class match
        // (CWE-209). The shared redactor over-redacts instead of leaking.
        cause: redactLegacyConnectionString(endpoint.ref),
      }),
    );
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

    const acquireDatabase = (
      endpoint: LegacyPgDeltaDatabaseEndpoint,
      projectEnv: Readonly<Record<string, string>>,
    ) =>
      legacyParsePgDeltaNextEndpoint(endpoint, projectEnv).pipe(
        Effect.flatMap((connection) => legacyAcquirePgPool(connection, endpoint.connectOptions)),
      );

    const reportDiagnostics = (
      operation: LegacyPgDeltaNextOperation,
      diagnostics: Parameters<typeof legacyReportPgDeltaNextDiagnostics>[1],
      strictCoverage: boolean,
      verboseDiagnostics: boolean,
    ) => {
      const report = legacyPgDeltaNextDiagnosticReport(diagnostics, strictCoverage);
      const showFeedback = !feedbackInvitationShown && report.unmodeledKinds.length > 0;
      if (showFeedback) feedbackInvitationShown = true;
      return legacyReportPgDeltaNextDiagnostics(
        operation,
        diagnostics,
        strictCoverage,
        showFeedback,
        verboseDiagnostics,
      ).pipe(
        Effect.provideService(Output, output),
        Effect.provideService(LegacyDebugLogger, debugLogger),
      );
    };

    const diffPools = (
      input: {
        readonly context: { readonly cwd: string };
        readonly schema: ReadonlyArray<string>;
        readonly formatOptions: string;
        readonly debug: boolean;
        readonly strictCoverage: boolean;
      },
      sourcePool: Pool,
      desiredPool: Pool,
    ) =>
      Effect.gen(function* () {
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
        yield* reportDiagnostics("diff", result.diagnostics, input.strictCoverage, input.debug);
        return normalizeNextDiff(result, debugDirectory);
      });

    return LegacyPgDeltaEngine.of({
      implementation: "next",
      diffExplicit: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            let shadow: { readonly migrationsUrl: string } | undefined;
            const migrationsEndpoint =
              input.source.kind === "migrations"
                ? input.source
                : input.desired.kind === "migrations"
                  ? input.desired
                  : undefined;
            if (migrationsEndpoint !== undefined) {
              if (input.toml === undefined) {
                return yield* Effect.fail(
                  new LegacyPgDeltaEngineError({
                    message: "pg-delta migrations endpoint requires loaded database config",
                    cause: "missing database config",
                  }),
                );
              }
              shadow = yield* shadowService.provisionMigrations({
                context: input.context,
                toml: input.toml,
                ...(migrationsEndpoint.projectRef !== undefined
                  ? { projectRef: migrationsEndpoint.projectRef }
                  : {}),
              });
            }
            const endpointPool = (endpoint: LegacyPgDeltaEndpoint) =>
              Effect.gen(function* () {
                if (endpoint.kind === "database") {
                  return yield* acquireDatabase(endpoint, input.context.projectEnv);
                }
                if (shadow === undefined) {
                  return yield* Effect.die("missing pg-delta migrations shadow");
                }
                const connection = parseLegacyConnectionString(shadow.migrationsUrl);
                if (connection === undefined) {
                  return yield* Effect.fail(
                    new LegacyPgDeltaEngineError({
                      message: "failed to parse pg-delta migrations shadow URL",
                      cause: redactLegacyConnectionString(shadow.migrationsUrl),
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
            return yield* diffPools(input, sourcePool, desiredPool);
          }),
        ).pipe(Effect.mapError(legacyPgDeltaNextEngineError)),
      diffDatabase: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const migrationsPool = yield* acquireDatabase(input.source, input.context.projectEnv);
            const desiredPool = yield* acquireDatabase(input.target, input.context.projectEnv);
            return yield* diffPools(input, migrationsPool, desiredPool);
          }),
        ).pipe(Effect.mapError(legacyPgDeltaNextEngineError)),
      exportDeclarativeSchema: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* acquireDatabase(input.target, input.context.projectEnv);
            const result = yield* adapter.exportDeclarativeSchema({
              pool,
              schema: input.schema,
              formatOptions: input.formatOptions,
            });
            if (input.debug) {
              const capture = yield* adapter
                .captureSnapshot({ pool })
                .pipe(Effect.orElseSucceed(() => undefined));
              yield* saveDebugArtifacts(input.context.cwd, "declarativeExport", {
                ...(capture !== undefined ? { desiredSnapshot: capture.snapshot } : {}),
                diagnostics:
                  capture === undefined
                    ? result.diagnostics
                    : [...result.diagnostics, ...capture.diagnostics],
              });
            }
            yield* reportDiagnostics(
              "declarativeExport",
              result.diagnostics,
              input.strictCoverage,
              input.debug,
            );
            return { files: result.files, manifest: result.manifest };
          }),
        ).pipe(Effect.mapError(legacyPgDeltaNextEngineError)),
      planDeclarativeSchema: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const shadow = yield* shadowService.provisionPlan({
              context: input.context,
              toml: input.toml,
              ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
              ...(input.noCache ? { bypassCache: true } : {}),
            });
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
            yield* prepareDeclarativeShadow(declarativePool, input.files);
            const result = yield* adapter.planDeclarativeSchema({
              targetPool: migrationsPool,
              shadowPool: declarativePool,
              files: filesForDeclarativeShadowLoad(input.files),
              allowDrops: true,
              ...(shadow.allowSameDatabaseIdentity ? { allowSameDatabaseIdentity: true } : {}),
              debug: input.debug,
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
            yield* reportDiagnostics(
              "declarativePlan",
              result.diagnostics,
              input.strictCoverage,
              input.debug,
            );
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
