import { Clock, Effect, FileSystem, Layer, Path } from "effect";
import type { Pool } from "pg";

import { Output } from "../../../shared/output/output.service.ts";
import {
  layeredParseEnv,
  parseConnectionString,
  redactConnectionString,
} from "../../../command-internal/db-config.parse.ts";
import { DbConnectError } from "../../../command-internal/db-connection.errors.ts";
import { acquirePgPool } from "../../../command-internal/db-connection.sql-pg.layer.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import {
  filesForDeclarativeShadowLoad,
  prepareDeclarativeShadow,
} from "./pgdelta-declarative-shadow-prep.ts";
import {
  PgDeltaEngine,
  PgDeltaEngineError,
  type PgDeltaDatabaseEndpoint,
  type PgDeltaDiffResult,
  type PgDeltaEndpoint,
} from "./pgdelta-engine.service.ts";
import {
  PgDeltaNextAdapter,
  PgDeltaNextError,
  type PgDeltaNextOperation,
} from "./pgdelta-next-adapter.service.ts";
import {
  formatPgDeltaNextDebugId,
  savePgDeltaNextDebugArtifacts,
  type PgDeltaNextDebugArtifacts,
} from "./pgdelta-next-artifacts.ts";
import {
  pgDeltaNextDiagnosticReport,
  reportPgDeltaNextDiagnostics,
} from "./pgdelta-next-diagnostics.ts";
import { PgDeltaNextShadow } from "./pgdelta-next-shadow.service.ts";

function pgDeltaNextConnectSuggestion(cause: unknown): string | undefined {
  if (cause instanceof DbConnectError) return cause.suggestion;
  if (typeof cause !== "object" || cause === null) return undefined;
  const nested = Reflect.get(cause, "cause");
  return nested === cause ? undefined : pgDeltaNextConnectSuggestion(nested);
}

export const pgDeltaNextEngineError = (cause: unknown) => {
  if (cause instanceof PgDeltaEngineError) return cause;
  const suggestion = pgDeltaNextConnectSuggestion(cause);
  const diagnostics = cause instanceof PgDeltaNextError ? cause.diagnostics : undefined;
  return new PgDeltaEngineError({
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
    readonly removals?: PgDeltaDiffResult["removals"];
    readonly hazards: NonNullable<PgDeltaDiffResult["hazards"]>;
    readonly debug?: {
      readonly sourceSnapshot?: string;
      readonly desiredSnapshot?: string;
      readonly plan?: string;
    };
  },
  debugDirectory?: string,
): PgDeltaDiffResult {
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

export function parsePgDeltaNextEndpoint(
  endpoint: PgDeltaDatabaseEndpoint,
  projectEnv: Readonly<Record<string, string>>,
) {
  return Effect.gen(function* () {
    if (endpoint.connection !== undefined) return endpoint.connection;
    const parsed = parseConnectionString(endpoint.ref, layeredParseEnv(projectEnv));
    if (parsed !== undefined) return parsed;
    return yield* Effect.fail(
      new PgDeltaEngineError({
        message: "failed to parse Postgres connection string for pg-delta",
        // The input is by definition unparseable, so a naive `:password@` regex could miss a
        // hand-typed password containing `/`, `@`, or `:` (CWE-209); `redactConnectionString`
        // over-redacts instead of risking a leak.
        cause: redactConnectionString(endpoint.ref),
      }),
    );
  });
}

/** In-process pg-delta next implementation. Every pool and shadow is scope-owned. */
export const pgDeltaNextEngineLayer = Layer.effect(
  PgDeltaEngine,
  Effect.gen(function* () {
    const adapter = yield* PgDeltaNextAdapter;
    const shadowService = yield* PgDeltaNextShadow;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const debugLogger = yield* DebugLogger;
    const output = yield* Output;
    let feedbackInvitationShown = false;

    const saveDebugArtifacts = (
      workdir: string,
      operation: PgDeltaNextOperation,
      artifacts: PgDeltaNextDebugArtifacts,
    ) =>
      Effect.gen(function* () {
        const id = formatPgDeltaNextDebugId(yield* Clock.currentTimeMillis, operation);
        const debugDir = yield* savePgDeltaNextDebugArtifacts(
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
      endpoint: PgDeltaDatabaseEndpoint,
      projectEnv: Readonly<Record<string, string>>,
    ) =>
      parsePgDeltaNextEndpoint(endpoint, projectEnv).pipe(
        Effect.flatMap((connection) => acquirePgPool(connection, endpoint.connectOptions)),
      );

    const reportDiagnostics = (
      operation: PgDeltaNextOperation,
      diagnostics: Parameters<typeof reportPgDeltaNextDiagnostics>[1],
      strictCoverage: boolean,
      verboseDiagnostics: boolean,
    ) => {
      const report = pgDeltaNextDiagnosticReport(diagnostics, strictCoverage);
      const showFeedback = !feedbackInvitationShown && report.unmodeledKinds.length > 0;
      if (showFeedback) feedbackInvitationShown = true;
      return reportPgDeltaNextDiagnostics(
        operation,
        diagnostics,
        strictCoverage,
        showFeedback,
        verboseDiagnostics,
      ).pipe(
        Effect.provideService(Output, output),
        Effect.provideService(DebugLogger, debugLogger),
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

    return PgDeltaEngine.of({
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
                  new PgDeltaEngineError({
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
            const endpointPool = (endpoint: PgDeltaEndpoint) =>
              Effect.gen(function* () {
                if (endpoint.kind === "database") {
                  return yield* acquireDatabase(endpoint, input.context.projectEnv);
                }
                if (shadow === undefined) {
                  return yield* Effect.die("missing pg-delta migrations shadow");
                }
                const connection = parseConnectionString(shadow.migrationsUrl);
                if (connection === undefined) {
                  return yield* Effect.fail(
                    new PgDeltaEngineError({
                      message: "failed to parse pg-delta migrations shadow URL",
                      cause: redactConnectionString(shadow.migrationsUrl),
                    }),
                  );
                }
                return yield* acquirePgPool(connection, {
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
        ).pipe(Effect.mapError(pgDeltaNextEngineError)),
      diffDatabase: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const migrationsPool = yield* acquireDatabase(input.source, input.context.projectEnv);
            const desiredPool = yield* acquireDatabase(input.target, input.context.projectEnv);
            return yield* diffPools(input, migrationsPool, desiredPool);
          }),
        ).pipe(Effect.mapError(pgDeltaNextEngineError)),
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
        ).pipe(Effect.mapError(pgDeltaNextEngineError)),
      planDeclarativeSchema: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const shadowInput = {
              context: input.context,
              toml: input.toml,
              ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
              ...(input.noCache ? { bypassCache: true } : {}),
            };
            const source = input.source;
            const planContext =
              source === undefined
                ? yield* Effect.gen(function* () {
                    const shadow = yield* shadowService.provisionPlan(shadowInput);
                    const migrations = parseConnectionString(shadow.migrationsUrl);
                    if (migrations === undefined) {
                      return yield* Effect.fail(
                        new PgDeltaEngineError({
                          message: "failed to parse pg-delta next shadow database URL",
                          cause: "invalid password-free shadow output",
                        }),
                      );
                    }
                    return {
                      declarativeUrl: shadow.declarativeUrl,
                      sourcePool: acquirePgPool(migrations, {
                        isLocal: true,
                        dnsResolver: "native",
                      }),
                      allowSameDatabaseIdentity: shadow.allowSameDatabaseIdentity,
                      sourceRef: "pg-delta-next:migrations",
                    };
                  })
                : yield* Effect.gen(function* () {
                    const shadow = yield* shadowService.provisionDeclarative(shadowInput);
                    return {
                      declarativeUrl: shadow.declarativeUrl,
                      sourcePool: acquireDatabase(source, input.context.projectEnv),
                      allowSameDatabaseIdentity: false,
                      sourceRef: "pg-delta-next:database",
                    };
                  });
            const declarative = parseConnectionString(planContext.declarativeUrl);
            if (declarative === undefined) {
              return yield* Effect.fail(
                new PgDeltaEngineError({
                  message: "failed to parse pg-delta next shadow database URL",
                  cause: "invalid password-free shadow output",
                }),
              );
            }
            const [sourcePool, declarativePool] = yield* Effect.all(
              [
                planContext.sourcePool,
                acquirePgPool(declarative, { isLocal: true, dnsResolver: "native" }),
              ],
              { concurrency: 2 },
            );
            const prep = yield* prepareDeclarativeShadow(declarativePool, input.files);
            const result = yield* adapter.planDeclarativeSchema({
              targetPool: sourcePool,
              shadowPool: declarativePool,
              files: filesForDeclarativeShadowLoad(input.files, prep.restorePgjwt),
              allowDrops: true,
              ...(planContext.allowSameDatabaseIdentity ? { allowSameDatabaseIdentity: true } : {}),
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
              sourceRef: planContext.sourceRef,
              targetRef: "pg-delta-next:declarative",
            };
          }),
        ).pipe(Effect.mapError(pgDeltaNextEngineError)),
    });
  }),
);
