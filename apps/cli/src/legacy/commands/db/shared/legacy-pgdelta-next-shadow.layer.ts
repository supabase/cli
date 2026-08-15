import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Net from "node:net";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  legacyResolveDebugWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import {
  legacyBuildLocalDbContainerInputs,
  type LegacyLocalDbContainerInputs,
} from "../../../shared/db-bootstrap/local-container-inputs.ts";
import { legacyWaitForShadowReady } from "../../../shared/db-bootstrap/health-check.ts";
import {
  legacyAcquireShadowDatabase,
  type LegacyShadowAcquiredHandle,
  type LegacyShadowCacheOpts,
} from "../../../shared/db-bootstrap/shadow-cache.ts";
import {
  legacyConnectShadowDatabase,
  legacyMigrateNextShadowDatabase,
  legacyRemoveShadowDatabase,
  legacyShadowRunInputFromLocalContainerInputs,
  legacySetupShadowDatabase,
} from "../../../shared/db-bootstrap/shadow-database.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  LegacyPgDeltaNextShadow,
  type LegacyPgDeltaNextMigrationsShadow,
  type LegacyPgDeltaNextPlanShadows,
  type LegacyPgDeltaNextShadowInput,
} from "./legacy-pgdelta-next-shadow.service.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

const allocateFreeHostPort = Effect.callback<Option.Option<number>>((resume) => {
  const server = Net.createServer();
  server.once("error", () => resume(Effect.succeed(Option.none())));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port > 0 ? Option.some(port) : Option.none())));
  });
});

const nextShadowError = (cause: unknown) =>
  cause instanceof LegacyDeclarativeShadowDbError
    ? cause
    : new LegacyDeclarativeShadowDbError({
        message:
          typeof cause === "object" &&
          cause !== null &&
          typeof Reflect.get(cause, "message") === "string"
            ? String(Reflect.get(cause, "message"))
            : String(cause),
        ...(typeof cause === "object" &&
        cause !== null &&
        Reflect.get(cause, "reason") === "docker_daemon"
          ? { docker: "daemon" as const }
          : {}),
      });

interface NativeShadowInput {
  readonly spawner: ChildProcessSpawnerType["Service"];
  readonly localInputs: LegacyLocalDbContainerInputs;
  readonly base: ReturnType<typeof legacyShadowRunInputFromLocalContainerInputs>;
}

interface NativeShadowBase {
  readonly localInputs: LegacyLocalDbContainerInputs;
  readonly image: string;
}

interface ProvisionedMigrationsShadow extends LegacyPgDeltaNextMigrationsShadow {
  readonly restoredFromPgDataSnapshot: boolean;
}

interface ProvisionedDeclarativeShadow {
  readonly declarativeUrl: string;
  readonly restoredFromPgDataSnapshot: boolean;
}

export function legacyAllowSameDatabaseIdentityForRestoredShadows(
  migrations: Pick<ProvisionedMigrationsShadow, "restoredFromPgDataSnapshot">,
  declarative: Pick<ProvisionedDeclarativeShadow, "restoredFromPgDataSnapshot">,
): boolean {
  return migrations.restoredFromPgDataSnapshot && declarative.restoredFromPgDataSnapshot;
}

/**
 * Removes extensions that the legacy PG14 platform baseline installs implicitly
 * so the declarative shadow reflects only extension declarations in schema files.
 * `pgjwt` has a hard extension dependency on `pgcrypto`, and `storage.objects.id`
 * depends on `uuid-ossp`, so both dependencies must be detached before the
 * user-manageable extensions can be dropped with the default RESTRICT behavior.
 */
export const legacyPreparePgDeltaNextDeclarativeBaseline = Effect.fnUntraced(function* (
  session: Pick<LegacyDbSession, "exec">,
  majorVersion: number,
) {
  if (majorVersion === 14) {
    yield* session.exec("ALTER TABLE storage.objects ALTER COLUMN id DROP DEFAULT");
    yield* session.exec("DROP EXTENSION IF EXISTS pgjwt");
  }
  yield* session.exec("DROP EXTENSION IF EXISTS pgcrypto");
  yield* session.exec('DROP EXTENSION IF EXISTS "uuid-ossp"');
});

const setupRunInput = (input: NativeShadowInput, handle: LegacyShadowAcquiredHandle) => ({
  fs: input.base.fs,
  path: input.base.path,
  workdir: input.base.workdir,
  projectId: input.base.projectId,
  container: handle.containerId,
  networkId: input.base.networkId,
  connConfig: {
    host: input.base.hostname,
    port: input.base.shadowPort,
    user: "postgres",
    password: input.base.password,
    database: "postgres",
  },
  setup: input.base.setup,
});

/**
 * Scoped, native TypeScript shadow orchestration for pg-delta next. The command
 * workflows and this specialized two-shadow planner share the same bootstrap
 * primitives; no Go command or shadow handoff protocol is involved.
 */
export const legacyPgDeltaNextShadowLayer = Layer.effect(
  LegacyPgDeltaNextShadow,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* LegacyNetworkIdFlag;
    const debugFlag = yield* LegacyDebugFlag;
    const experimentalFlag = yield* LegacyExperimentalFlag;
    const cliArgs = yield* CliArgs;
    const output = yield* Output;
    const docker = yield* LegacyDockerRun;
    const dbConnection = yield* LegacyDbConnection;
    const httpClient = yield* HttpClient.HttpClient;

    const runtime = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(Path.Path, path),
      Layer.succeed(LegacyDebugFlag, debugFlag),
      Layer.succeed(LegacyExperimentalFlag, experimentalFlag),
      Layer.succeed(LegacyNetworkIdFlag, networkIdFlag),
      Layer.succeed(CliArgs, cliArgs),
      Layer.succeed(Output, output),
      Layer.succeed(RuntimeInfo, runtimeInfo),
      Layer.succeed(LegacyDockerRun, docker),
      Layer.succeed(LegacyDbConnection, dbConnection),
      Layer.succeed(HttpClient.HttpClient, httpClient),
    );

    const nextPort = (excluded?: number) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 10; attempt++) {
          const candidate = yield* allocateFreeHostPort;
          if (Option.isSome(candidate) && candidate.value !== excluded) return candidate.value;
        }
        return yield* Effect.fail(
          new LegacyDeclarativeShadowDbError({
            message:
              excluded === undefined
                ? "failed to allocate a host port for pg-delta shadow database"
                : `failed to allocate a host port distinct from ${excluded}`,
          }),
        );
      });

    const buildNativeBase = (request: LegacyPgDeltaNextShadowInput) =>
      Effect.gen(function* () {
        const debug = yield* legacyResolveDebugWithProjectEnv(request.toml.projectEnv);
        const localInputs = yield* legacyBuildLocalDbContainerInputs(
          spawner,
          request.context.cwd,
          networkIdFlag,
          runtimeInfo.platform,
          debug,
          request.projectRef,
          request.toml.remoteOverrideKeys,
        );
        const image = yield* localInputs.resolvePostgresImage;
        return { localInputs, image } satisfies NativeShadowBase;
      }).pipe(Effect.provide(runtime));

    const buildNativeInput = (
      request: LegacyPgDeltaNextShadowInput,
      built: NativeShadowBase,
      port: number,
    ): NativeShadowInput => ({
      spawner,
      localInputs: built.localInputs,
      base: legacyShadowRunInputFromLocalContainerInputs(
        built.localInputs,
        built.image,
        { ...request.toml, shadowPort: port },
        fs,
        path,
      ),
    });

    /**
     * Cache-aware acquire, released when the current scope closes — next returns a URL the
     * engine keeps using after provision, so this cannot be `legacyWithShadowDatabase`
     * (that wrapper removes the container when `use` returns).
     */
    const acquireShadow = (input: NativeShadowInput, opts: LegacyShadowCacheOpts) =>
      Effect.acquireRelease(
        legacyAcquireShadowDatabase(input.spawner, input.base, opts),
        (handle) =>
          legacyRemoveShadowDatabase(input.spawner, handle.containerId).pipe(
            Effect.provideService(Output, output),
          ),
      );

    const awaitShadowReady = (input: NativeShadowInput, handle: LegacyShadowAcquiredHandle) =>
      legacyWaitForShadowReady(
        input.spawner,
        handle.containerId,
        {
          host: input.base.hostname,
          port: input.base.shadowPort,
          user: "postgres",
          password: input.base.password,
          database: "postgres",
        },
        {
          timeoutSeconds: input.base.healthTimeoutSeconds,
          image: input.base.image,
        },
      );

    const provisionMigrations = (input: NativeShadowInput, opts: LegacyShadowCacheOpts) =>
      Effect.gen(function* () {
        const handle = yield* acquireShadow(input, opts);
        yield* awaitShadowReady(input, handle);
        const setup = setupRunInput(input, handle);
        yield* legacyMigrateNextShadowDatabase(input.spawner, setup, handle);
        return {
          migrationsUrl: legacyToPostgresURL(setup.connConfig),
          restoredFromPgDataSnapshot: handle.baselinePresent,
        } satisfies ProvisionedMigrationsShadow;
      }).pipe(Effect.provide(runtime), Effect.mapError(nextShadowError));

    const provisionDeclarative = (input: NativeShadowInput, opts: LegacyShadowCacheOpts) =>
      Effect.gen(function* () {
        const handle = yield* acquireShadow(input, opts);
        yield* awaitShadowReady(input, handle);
        const setup = setupRunInput(input, handle);
        yield* legacySetupShadowDatabase(input.spawner, setup, { webhooks: "disabled" }, handle);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* legacyConnectShadowDatabase(setup.connConfig);
            yield* legacyPreparePgDeltaNextDeclarativeBaseline(
              session,
              input.base.setup.majorVersion,
            );
          }),
        );
        return {
          declarativeUrl: legacyToPostgresURL(setup.connConfig),
          restoredFromPgDataSnapshot: handle.baselinePresent,
        } satisfies ProvisionedDeclarativeShadow;
      }).pipe(Effect.provide(runtime), Effect.mapError(nextShadowError));

    const cacheOpts = (
      opts: LegacyPgDeltaNextShadowInput,
      webhooks: NonNullable<LegacyShadowCacheOpts["webhooks"]>,
    ): LegacyShadowCacheOpts => ({
      webhooks,
      ...(opts.bypassCache === true ? { bypassCache: true } : {}),
    });

    return LegacyPgDeltaNextShadow.of({
      provisionMigrations: (opts) =>
        Effect.gen(function* () {
          const port = yield* nextPort();
          const built = yield* buildNativeBase(opts);
          const input = buildNativeInput(opts, built, port);
          return yield* provisionMigrations(input, cacheOpts(opts, "config"));
        }).pipe(Effect.mapError(nextShadowError)),
      provisionPlan: (opts) =>
        Effect.gen(function* () {
          const migrationsPort = yield* nextPort();
          const declarativePort = yield* nextPort(migrationsPort);
          const built = yield* buildNativeBase(opts);
          const migrationsInput = buildNativeInput(opts, built, migrationsPort);
          const declarativeInput = buildNativeInput(opts, built, declarativePort);
          const migrations = yield* provisionMigrations(migrationsInput, cacheOpts(opts, "config"));
          const declarative = yield* provisionDeclarative(
            declarativeInput,
            cacheOpts(opts, "disabled"),
          );
          return {
            migrationsUrl: migrations.migrationsUrl,
            declarativeUrl: declarative.declarativeUrl,
            allowSameDatabaseIdentity: legacyAllowSameDatabaseIdentityForRestoredShadows(
              migrations,
              declarative,
            ),
          } satisfies LegacyPgDeltaNextPlanShadows;
        }).pipe(Effect.mapError(nextShadowError)),
    });
  }),
);
