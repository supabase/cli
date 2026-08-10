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
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import {
  legacyBuildLocalDbContainerInputs,
  type LegacyLocalDbContainerInputs,
} from "../../../shared/db-bootstrap/local-container-inputs.ts";
import { legacyWaitForHealthyServices } from "../../../shared/db-bootstrap/health-check.ts";
import {
  legacyConnectShadowDatabase,
  legacyCreateShadowDatabase,
  legacyMigrateNextShadowDatabase,
  legacyRemoveShadowDatabase,
  legacySetupShadowDatabase,
  type LegacyShadowDatabaseHandle,
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
import { legacyShadowRunInputFromLocalContainerInputs } from "./legacy-shadow-source.ts";
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

const setupRunInput = (input: NativeShadowInput, handle: LegacyShadowDatabaseHandle) => ({
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

    const acquireShadow = (input: NativeShadowInput) =>
      Effect.acquireRelease(legacyCreateShadowDatabase(input.spawner, input.base), (handle) =>
        legacyRemoveShadowDatabase(input.spawner, handle.containerId).pipe(
          Effect.provideService(Output, output),
        ),
      );

    const provisionMigrations = (input: NativeShadowInput) =>
      Effect.gen(function* () {
        const handle = yield* acquireShadow(input);
        yield* legacyWaitForHealthyServices(input.spawner, [handle.containerId], {
          timeoutSeconds: input.base.healthTimeoutSeconds,
        });
        const setup = setupRunInput(input, handle);
        yield* legacyMigrateNextShadowDatabase(input.spawner, setup);
        return {
          migrationsUrl: legacyToPostgresURL(setup.connConfig),
        } satisfies LegacyPgDeltaNextMigrationsShadow;
      }).pipe(Effect.provide(runtime), Effect.mapError(nextShadowError));

    const provisionDeclarative = (input: NativeShadowInput) =>
      Effect.gen(function* () {
        if (input.localInputs.setup.majorVersion !== 17) {
          return yield* Effect.fail(
            new LegacyDeclarativeShadowDbError({
              message: `pg-delta declarative shadow baseline requires Postgres 17 (got major ${input.localInputs.setup.majorVersion}, image ${JSON.stringify(input.base.image)})`,
            }),
          );
        }
        const handle = yield* acquireShadow(input);
        yield* legacyWaitForHealthyServices(input.spawner, [handle.containerId], {
          timeoutSeconds: input.base.healthTimeoutSeconds,
        });
        const setup = setupRunInput(input, handle);
        yield* legacySetupShadowDatabase(input.spawner, setup, {
          activateUserExtensions: false,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* legacyConnectShadowDatabase(setup.connConfig);
            yield* session.exec("DROP EXTENSION IF EXISTS pgcrypto");
            yield* session.exec('DROP EXTENSION IF EXISTS "uuid-ossp"');
          }),
        );
        return legacyToPostgresURL(setup.connConfig);
      }).pipe(Effect.provide(runtime), Effect.mapError(nextShadowError));

    return LegacyPgDeltaNextShadow.of({
      provisionMigrations: (opts) =>
        Effect.gen(function* () {
          const port = yield* nextPort();
          const built = yield* buildNativeBase(opts);
          const input = buildNativeInput(opts, built, port);
          return yield* provisionMigrations(input);
        }).pipe(Effect.mapError(nextShadowError)),
      provisionPlan: (opts) =>
        Effect.gen(function* () {
          const migrationsPort = yield* nextPort();
          const declarativePort = yield* nextPort(migrationsPort);
          const built = yield* buildNativeBase(opts);
          const migrationsInput = buildNativeInput(opts, built, migrationsPort);
          const declarativeInput = buildNativeInput(opts, built, declarativePort);
          const migrations = yield* provisionMigrations(migrationsInput);
          const declarativeUrl = yield* provisionDeclarative(declarativeInput);
          return {
            ...migrations,
            declarativeUrl,
          } satisfies LegacyPgDeltaNextPlanShadows;
        }).pipe(Effect.mapError(nextShadowError)),
    });
  }),
);
