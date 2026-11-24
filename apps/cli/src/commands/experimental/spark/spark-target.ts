import {
  makeSparkAdmin,
  type SparkAdminError,
  sparkDryRun,
  type SparkDryRunStatus,
  type SparkTypegenError,
  sparkTypescriptTypes,
} from "@supabase/stack/spark";
import { Clock, Context, Effect, Option, Result } from "effect";
import { HttpClient } from "effect/http";

import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { configureLoopbackProxyBypass } from "../../../command-internal/hostname.ts";
import { sanitizeErrorBody } from "../../../command-internal/http-errors.ts";
import { formatMigrationTimestamp } from "../../../command-internal/migration-file.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { parseTargetSelector } from "../../../command-internal/target/target-selector.ts";
import {
  resolveTarget,
  type ResolvedTarget,
} from "../../../command-internal/target/resolve-target.ts";
import type { TargetFlagValues } from "../../../command-internal/target/target-flags.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  applySparkMigration,
  dryRunSparkMigration,
  dumpSparkSchema,
  listSparkMigrations,
  resetSparkDatabase,
  runSparkQuery,
  sparkTypescriptTypes as remoteTypescriptTypes,
} from "./spark-api.ts";
import { requireDevInstanceState, SparkDevInstanceMode } from "./spark-dev-instance.ts";
import { SparkApiError, SparkBackendError } from "./spark-project.ts";
import { isSparkRunning, openSpark } from "./spark-stack.ts";

type SparkTargetError = SparkApiError | SparkBackendError;

/** How a Spark command reaches the project: the local Spark server, or a linked project. */
export class SparkTarget extends Context.Service<
  SparkTarget,
  {
    /** Runs SQL and resolves to the rows' JSON text, whose column order the output keeps. */
    readonly runQuery: (
      query: string,
      readOnly: boolean,
    ) => Effect.Effect<string, SparkTargetError>;
    readonly listMigrations: Effect.Effect<
      ReadonlyArray<{ readonly version: string }>,
      SparkTargetError
    >;
    /** Applies one migration under its version; `null` when nothing was recorded. */
    readonly applyMigration: (migration: {
      readonly query: string;
      readonly name: string;
      readonly version: string;
    }) => Effect.Effect<string | null, SparkTargetError>;
    readonly dryRunMigration: (migration: {
      readonly query: string;
      readonly name: string;
    }) => Effect.Effect<ReadonlyArray<SparkDryRunStatus>, SparkTargetError>;
    readonly dump: (schemas: ReadonlyArray<string>) => Effect.Effect<string, SparkTargetError>;
    readonly typescriptTypes: (
      schemas: ReadonlyArray<string>,
    ) => Effect.Effect<string, SparkTargetError>;
    /** Empties the database and its migration history. */
    readonly resetDatabase: Effect.Effect<void, SparkTargetError>;
  }
>()("supabase/cli/SparkTarget") {}

/** A migration version from the current time, as `supabase migration new` names one. */
export const migrationVersion = Effect.map(Clock.currentTimeMillis, formatMigrationTimestamp);

const remoteSparkTarget = Effect.fn("SparkTarget.remote")(function* (ref: string) {
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const context = yield* Effect.context<
    CommandSettings | CommandCredentials | HttpClient.HttpClient
  >();
  const bind = <
    A,
    E,
    R extends CommandPlatformApi | CommandSettings | CommandCredentials | HttpClient.HttpClient,
  >(
    effect: Effect.Effect<A, E, R>,
  ) => effect.pipe(Effect.provideService(CommandPlatformApi, api), Effect.provideContext(context));
  return SparkTarget.of({
    runQuery: (query, readOnly) => bind(runSparkQuery(ref, query, readOnly)),
    listMigrations: bind(listSparkMigrations(ref)),
    applyMigration: (migration) => bind(applySparkMigration(ref, migration)),
    dryRunMigration: (migration) => bind(dryRunSparkMigration(ref, migration)),
    dump: (schemas) => bind(dumpSparkSchema(ref, schemas)),
    typescriptTypes: (schemas) => bind(remoteTypescriptTypes(ref, schemas)),
    resetDatabase: bind(resetSparkDatabase(ref)),
  });
});

const NOT_RUNNING =
  "No local Spark stack is running for this project. Run `supabase start`, or select the linked project with --remote.";

const stackFailure = (cause: { readonly message: string }) =>
  new SparkBackendError({ message: cause.message, cause });

/** The running stack's API URL and service_role key, which the proxy forwards to Spark. */
const localConnection = Effect.fn("SparkTarget.localConnection")(function* () {
  const found = yield* openSpark();
  if (Option.isNone(found) || !(yield* isSparkRunning(found.value.spark)))
    return yield* new SparkBackendError({ message: NOT_RUNNING });
  const credentials = yield* found.value.stack.credentials.get.pipe(Effect.mapError(stackFailure));
  const { apiUrl } = yield* found.value.spark
    .credentials({ from: "host" })
    .pipe(Effect.mapError(stackFailure));
  if (credentials === undefined || apiUrl === undefined)
    return yield* new SparkBackendError({ message: NOT_RUNNING });
  return { url: apiUrl, serviceRoleKey: credentials.serviceRoleKey };
});

const adminFailure =
  (what: string) =>
  (error: SparkAdminError | SparkTypegenError): SparkTargetError => {
    switch (error._tag) {
      case "SparkQueryError":
        return new SparkApiError({
          message: `${what} failed (HTTP ${error.status}): ${sanitizeErrorBody(error.message)}`,
          status: error.status,
        });
      case "SparkTypegenError":
        return new SparkApiError({ message: `${what} failed: ${error.message}`, cause: error });
      default:
        return new SparkBackendError({ message: `${what} failed: ${error.message}`, cause: error });
    }
  };

const localSparkTarget = Effect.fn("SparkTarget.local")(function* () {
  // A proxy from the environment would otherwise receive the service_role key of a loopback call.
  configureLoopbackProxyBypass();
  const { url, serviceRoleKey } = yield* Effect.scoped(localConnection());
  const admin = makeSparkAdmin(yield* HttpClient.HttpClient, url, serviceRoleKey);
  const only = (schemas: ReadonlyArray<string>) => (schemas.length === 0 ? undefined : schemas);
  return SparkTarget.of({
    runQuery: (query, readOnly) =>
      admin.queryText(query, [], readOnly).pipe(Effect.mapError(adminFailure("run query"))),
    listMigrations: admin.migrations.pipe(Effect.mapError(adminFailure("list migrations"))),
    applyMigration: (migration) =>
      admin
        .applyMigration(migration.version, migration.name, migration.query)
        .pipe(
          Effect.as(migration.version),
          Effect.mapError(adminFailure(`apply migration ${migration.version}_${migration.name}`)),
        ),
    dryRunMigration: (migration) =>
      migrationVersion.pipe(
        Effect.flatMap((version) =>
          sparkDryRun(admin, { version, name: migration.name, sql: migration.query }),
        ),
        Effect.mapError(adminFailure("dry-run migration")),
      ),
    dump: (schemas) =>
      admin.dump(only(schemas)).pipe(Effect.mapError(adminFailure("database dump"))),
    typescriptTypes: (schemas) =>
      sparkTypescriptTypes(admin, only(schemas)).pipe(
        Effect.mapError(adminFailure("generate types")),
      ),
    // The local database is rebuilt by `spark db reset` while the stack is stopped (`db reset`).
    resetDatabase: Effect.fail(
      new SparkBackendError({
        message: "The local Spark database is reset by `supabase db reset`.",
      }),
    ),
  });
});

/** The checkout's dev instance, reached through the Management API like a linked project. */
const devInstanceSparkTarget = Effect.fn("SparkTarget.devInstance")(function* () {
  const state = yield* requireDevInstanceState();
  return yield* remoteSparkTarget(state.ref);
});

/** Runs `body` with the dev instance's {@link SparkTarget} (`start`, `db reset`). */
export const withDevInstanceTarget = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.provideServiceEffect(SparkTarget, devInstanceSparkTarget()));

/** Whether no target flag was given, so the mode's default target applies. */
const selectsDefaultTarget = Effect.fnUntraced(function* (flags: TargetFlagValues) {
  const cliArgs = Option.getOrUndefined(yield* Effect.serviceOption(CliArgs));
  const parsed = parseTargetSelector(flags, { remoteConflict: cliArgs?.remoteConflict === true });
  return Result.isSuccess(parsed) && parsed.success.selection._tag === "Default";
});

/**
 * Resolves the command's target and runs `body` with its {@link SparkTarget}: the local Spark
 * server by default (the dev instance in dev-instance mode), the Management API for a linked
 * project, which is cached for telemetry.
 */
export const withSparkTarget = <A, E, R>(
  flags: TargetFlagValues,
  body: (target: ResolvedTarget) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const telemetryState = yield* TelemetryState;
    const run = Effect.gen(function* () {
      // A personal dev instance is treated like the local stack: its writes need no consent.
      if ((yield* SparkDevInstanceMode) && (yield* selectsDefaultTarget(flags)))
        return yield* withDevInstanceTarget(body({ kind: "local" }));
      const target = yield* resolveTarget(flags);
      switch (target.kind) {
        case "linked": {
          const linkedProjectCache = yield* LinkedProjectCache;
          return yield* body(target).pipe(
            Effect.provideServiceEffect(SparkTarget, remoteSparkTarget(target.ref)),
            Effect.ensuring(linkedProjectCache.cache(target.ref)),
          );
        }
        case "local":
          return yield* body(target).pipe(
            Effect.provideServiceEffect(SparkTarget, localSparkTarget()),
          );
        case "db-url":
          return yield* new SparkBackendError({
            message: "A Spark project is reached through its project ref, not a database URL.",
          });
      }
    });
    return yield* run.pipe(Effect.ensuring(telemetryState.flush));
  });
