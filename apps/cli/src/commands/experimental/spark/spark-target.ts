import type { SparkDryRunStatus } from "@supabase/stack/spark";
import { Clock, Context, Effect } from "effect";
import { HttpClient } from "effect/http";

import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { formatMigrationTimestamp } from "../../../command-internal/migration-file.ts";
import {
  resolveHostedRemote,
  selectTarget,
} from "../../../command-internal/target/remote-resolution.ts";
import type { LinkedTarget } from "../../../command-internal/target/resolve-target.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  applySparkMigration,
  dryRunSparkMigration,
  dumpSparkSchema,
  listSparkMigrations,
  resetSparkDatabase,
  runSparkQuery,
  sparkTypescriptTypes,
} from "./spark-api.ts";
import { type ReadyDevInstanceState, requireReadyDevInstanceState } from "./spark-dev-instance.ts";
import type { SparkApiError } from "./spark-project.ts";
import type { SparkTargetFlagValues } from "./spark.flags.ts";

/** How a Spark command reaches the project: the Management API, for its ref. */
export class SparkTarget extends Context.Service<
  SparkTarget,
  {
    /** Runs SQL and resolves to the rows' JSON text, whose column order the output keeps. */
    readonly runQuery: (query: string, readOnly: boolean) => Effect.Effect<string, SparkApiError>;
    readonly listMigrations: Effect.Effect<
      ReadonlyArray<{ readonly version: string }>,
      SparkApiError
    >;
    /** Applies one migration under its version; `null` when nothing was recorded. */
    readonly applyMigration: (migration: {
      readonly query: string;
      readonly name: string;
      readonly version: string;
    }) => Effect.Effect<string | null, SparkApiError>;
    readonly dryRunMigration: (migration: {
      readonly query: string;
      readonly name: string;
    }) => Effect.Effect<ReadonlyArray<SparkDryRunStatus>, SparkApiError>;
    readonly dump: (schemas: ReadonlyArray<string>) => Effect.Effect<string, SparkApiError>;
    readonly typescriptTypes: (
      schemas: ReadonlyArray<string>,
    ) => Effect.Effect<string, SparkApiError>;
    /** Empties the database and its migration history. */
    readonly resetDatabase: Effect.Effect<void, SparkApiError>;
  }
>()("supabase/cli/SparkTarget") {}

/**
 * The project a Spark command acts on: the checkout's dev instance (no target flag), or the
 * linked project `--remote` selects.
 */
export type SparkProject =
  | { readonly kind: "dev-instance"; readonly state: ReadyDevInstanceState }
  | LinkedTarget;

/** A migration version from the current time, as `supabase migration new` names one. */
export const migrationVersion = Effect.map(Clock.currentTimeMillis, formatMigrationTimestamp);

const sparkTargetFor = Effect.fn("SparkTarget.make")(function* (ref: string) {
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
    typescriptTypes: (schemas) => bind(sparkTypescriptTypes(ref, schemas)),
    resetDatabase: bind(resetSparkDatabase(ref)),
  });
});

/** Runs `body` with the dev instance's {@link SparkTarget}, which `start` must have set up. */
export const withDevInstanceTarget = <A, E, R>(
  body: (state: ReadyDevInstanceState) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const state = yield* requireReadyDevInstanceState();
    return yield* body(state).pipe(
      Effect.provideServiceEffect(SparkTarget, sparkTargetFor(state.ref)),
    );
  });

/**
 * Resolves the command's project and runs `body` with its {@link SparkTarget}: the dev instance
 * by default, the linked project with `--remote`, which is cached for telemetry.
 */
export const withSparkTarget = <A, E, R>(
  flags: SparkTargetFlagValues,
  body: (project: SparkProject) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const telemetryState = yield* TelemetryState;
    const run = Effect.gen(function* () {
      const { selection } = yield* selectTarget({ ...flags, local: false });
      yield* Effect.annotateCurrentSpan({
        "target.kind": selection._tag === "Default" ? "dev-instance" : "linked",
      });
      switch (selection._tag) {
        case "Default":
          return yield* withDevInstanceTarget((state) => body({ kind: "dev-instance", state }));
        case "Linked":
        case "Ref":
        case "Branch": {
          const target = yield* resolveHostedRemote(selection);
          const linkedProjectCache = yield* LinkedProjectCache;
          return yield* body(target).pipe(
            Effect.provideServiceEffect(SparkTarget, sparkTargetFor(target.ref)),
            Effect.ensuring(linkedProjectCache.cache(target.ref)),
          );
        }
        case "Local":
        case "DbUrl":
          return yield* Effect.die(
            new Error(`The Spark target flags cannot select "${selection._tag}"`),
          );
      }
    });
    return yield* run.pipe(Effect.ensuring(telemetryState.flush));
  });
