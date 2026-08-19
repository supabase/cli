import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { loadProjectConfig } from "@supabase/config";
import {
  DEFAULT_VERSIONS,
  planStackVersions,
  renderNativePostgresInitScript,
  resolveNativeBinary,
} from "@supabase/stack/effect";
import { createHash } from "node:crypto";
import Net from "node:net";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { ProjectHome } from "../../next/config/project-home.service.ts";
import { ProjectLinkState } from "../../next/config/project-link-state.service.ts";
import { ProjectLocalServiceVersions } from "../../next/config/project-local-service-versions.service.ts";
import { IsolatedShadowProvisioner } from "./isolated-shadow.service.ts";
import { SchemaEngineError } from "./schema-errors.ts";
import { computeBaselineCacheKey, digestArtifactTree } from "./native-isolated-shadow-key.ts";

const NATIVE_POSTGRES_RUNTIME_ARGS = [
  "-c",
  "wal_level=logical",
  "-c",
  "max_wal_senders=5",
  "-c",
  "max_replication_slots=5",
  "-c",
  "listen_addresses=127.0.0.1",
] as const;

const READY_ATTEMPTS = 150;
const READY_DELAY = "200 millis" as const;
const LOCK_ATTEMPTS = 900;
const LOCK_DELAY = "100 millis" as const;

const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const shadowError = (detail: string, suggestion: string) =>
  new SchemaEngineError({ detail, suggestion });

const toShadowError = (error: unknown) => {
  if (error instanceof SchemaEngineError) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String(Reflect.get(error, "_tag"));
    const detailValue = Reflect.get(error, "detail");
    const detail = typeof detailValue === "string" ? detailValue : tag;
    return shadowError(detail, "Retry the command.");
  }
  return shadowError(error instanceof Error ? error.message : String(error), "Retry the command.");
};

const postgresEnv = (
  postgresDir: string,
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  ...process.env,
  DYLD_LIBRARY_PATH: `${postgresDir}/lib`,
  LD_LIBRARY_PATH: `${postgresDir}/lib`,
  PGPASSWORD: "postgres",
  POSTGRES_PASSWORD: "postgres",
  ...extra,
});

const cacheEnabled = () => {
  const value = process.env["SUPABASE_SHADOW_CACHE"];
  return value !== "0" && value !== "false";
};

const allocatePort = Effect.callback<number, SchemaEngineError>((resume) => {
  const server = Net.createServer();
  server.once("error", (error) =>
    resume(
      Effect.fail(
        shadowError(`Failed to allocate a shadow port: ${error.message}`, "Retry the command."),
      ),
    ),
  );
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => {
      if (port > 0) {
        resume(Effect.succeed(port));
        return;
      }
      resume(Effect.fail(shadowError("Failed to allocate a shadow port.", "Retry the command.")));
    });
  });
});

const startCommand = (postgresDir: string, dataDir: string, port: number) =>
  ChildProcess.make(
    "bash",
    [
      `${postgresDir}/share/supabase-cli/bin/supabase-postgres-init.sh`,
      "-p",
      String(port),
      ...NATIVE_POSTGRES_RUNTIME_ARGS,
    ],
    { env: postgresEnv(postgresDir, { PGDATA: dataDir }) },
  );

export const nativeIsolatedShadowLayer = Layer.effect(
  IsolatedShadowProvisioner,
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig;
    const projectHome = yield* ProjectHome;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const projectLink = yield* ProjectLinkState;
    const localVersions = yield* ProjectLocalServiceVersions;

    const requireExitZero = (command: ChildProcess.Command, detail: string) =>
      Effect.gen(function* () {
        const code = yield* spawner
          .exitCode(command)
          .pipe(
            Effect.mapError((error) =>
              shadowError(`${detail}: ${error.message}`, "Retry the command."),
            ),
          );
        if (code !== 0) {
          return yield* shadowError(`${detail} (exit ${code}).`, "Retry the command.");
        }
      });

    const retry = <A>(
      effect: Effect.Effect<A, SchemaEngineError>,
      attempts: number,
      delay: typeof READY_DELAY | typeof LOCK_DELAY,
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < attempts; attempt++) {
          const result = yield* Effect.result(effect);
          if (result._tag === "Success") return result.success;
          if (attempt === attempts - 1) {
            return yield* Effect.fail(result.failure);
          }
          yield* Effect.sleep(delay);
        }
        return yield* shadowError("Retry budget exhausted.", "Retry the command.");
      });

    const waitReady = (postgresDir: string, port: number) =>
      retry(
        requireExitZero(
          ChildProcess.make(
            `${postgresDir}/bin/pg_isready`,
            ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"],
            { env: postgresEnv(postgresDir) },
          ),
          "Isolated shadow Postgres did not become ready",
        ),
        READY_ATTEMPTS,
        READY_DELAY,
      );

    const applyPlatformBaseline = (
      postgresDir: string,
      port: number,
      autoExposeNewTables: boolean,
    ) =>
      requireExitZero(
        ChildProcess.make(
          "bash",
          [
            "-c",
            renderNativePostgresInitScript({
              postgresDir,
              dbPort: port,
              autoExposeNewTables,
            }),
          ],
          { env: postgresEnv(postgresDir) },
        ),
        "Failed to apply the platform baseline to the isolated shadow",
      );

    const startOwnedPostgres = (postgresDir: string, dataDir: string, port: number) =>
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(startCommand(postgresDir, dataDir, port))
          .pipe(
            Effect.mapError((error) =>
              shadowError(
                `Failed to start isolated shadow Postgres: ${error.message}`,
                "Retry the command.",
              ),
            ),
          );
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        yield* waitReady(postgresDir, port);
      });

    const provision = Effect.gen(function* () {
      const localState = yield* localVersions.load.pipe(Effect.mapError(toShadowError));
      const linkedState = yield* projectLink.load.pipe(Effect.mapError(toShadowError));
      const versions = planStackVersions({
        candidateBaseline: Option.match(linkedState, {
          onNone: () => undefined,
          onSome: (state) => state.versions,
        }),
        localOverrides: Option.match(localState, {
          onNone: () => undefined,
          onSome: (state) => state.versions,
        }),
      });
      const postgresVersion = versions.runtimeVersions.postgres ?? DEFAULT_VERSIONS.postgres;
      const loadedConfig = yield* loadProjectConfig(projectHome.projectRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(toShadowError),
      );
      const autoExposeNewTables = loadedConfig?.config.api.auto_expose_new_tables ?? false;
      const postgresDir = yield* resolveNativeBinary(cliConfig.supabaseHome, {
        service: "postgres",
        version: postgresVersion,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError((error) =>
          shadowError(
            `Failed to resolve native Postgres ${postgresVersion}: ${error._tag}`,
            "Run `supabase start` once so the native Postgres binary is cached, then retry.",
          ),
        ),
      );

      const artifactDigest = digestArtifactTree(`${postgresDir}/share/supabase-cli`);
      const key = computeBaselineCacheKey({
        postgresVersion,
        autoExposeNewTables,
        artifactDigest,
        initScriptDigest: createHash("sha256")
          .update(renderNativePostgresInitScript.toString())
          .digest("hex"),
      });
      const cacheRoot = path.join(cliConfig.supabaseHome, "cache", "native-shadow-baseline");
      const archivePath = path.join(cacheRoot, `shadow-baseline-${key}.tar`);
      const dataDir = yield* fs
        .makeTempDirectory({ prefix: "pgdelta-isolated-" })
        .pipe(
          Effect.mapError((error) =>
            shadowError(
              `Failed to create an isolated shadow directory: ${error.message}`,
              "Check disk space and retry.",
            ),
          ),
        );
      yield* Effect.addFinalizer(() =>
        fs.remove(dataDir, { recursive: true, force: true }).pipe(Effect.ignore),
      );

      const publishBaseline = Effect.scoped(
        Effect.gen(function* () {
          const buildDir = yield* fs
            .makeTempDirectory({ prefix: "pgdelta-baseline-" })
            .pipe(
              Effect.mapError((error) =>
                shadowError(
                  `Failed to create a baseline build directory: ${error.message}`,
                  "Check disk space and retry.",
                ),
              ),
            );
          yield* Effect.addFinalizer(() =>
            fs.remove(buildDir, { recursive: true, force: true }).pipe(Effect.ignore),
          );
          const buildData = path.join(buildDir, "data");
          yield* fs
            .makeDirectory(buildData, { recursive: true })
            .pipe(
              Effect.mapError((error) =>
                shadowError(
                  `Failed to create baseline PGDATA: ${error.message}`,
                  "Check disk space and retry.",
                ),
              ),
            );
          const port = yield* allocatePort;
          yield* startOwnedPostgres(postgresDir, buildData, port);
          yield* applyPlatformBaseline(postgresDir, port, autoExposeNewTables);
          yield* requireExitZero(
            ChildProcess.make(
              `${postgresDir}/bin/pg_ctl`,
              ["stop", "-D", buildData, "-m", "fast", "-w"],
              { env: postgresEnv(postgresDir) },
            ),
            "Failed to stop the baseline Postgres after snapshotting",
          );
          yield* fs
            .makeDirectory(cacheRoot, { recursive: true })
            .pipe(
              Effect.mapError((error) =>
                shadowError(
                  `Failed to create the shadow baseline cache: ${error.message}`,
                  "Check permissions on SUPABASE_HOME and retry.",
                ),
              ),
            );
          const staging = path.join(cacheRoot, `shadow-baseline-${key}.${process.pid}.partial`);
          yield* Effect.addFinalizer(() => fs.remove(staging, { force: true }).pipe(Effect.ignore));
          yield* requireExitZero(
            ChildProcess.make("tar", ["-cf", staging, "-C", buildData, "."]),
            "Failed to snapshot the isolated shadow baseline",
          );
          yield* fs
            .rename(staging, archivePath)
            .pipe(
              Effect.mapError((error) =>
                shadowError(
                  `Failed to publish the shadow baseline cache: ${error.message}`,
                  "Retry the command.",
                ),
              ),
            );
        }),
      );

      const withCacheLock = <A>(effect: Effect.Effect<A, SchemaEngineError>) =>
        Effect.gen(function* () {
          yield* fs
            .makeDirectory(cacheRoot, { recursive: true })
            .pipe(
              Effect.mapError((error) =>
                shadowError(
                  `Failed to create the shadow baseline cache: ${error.message}`,
                  "Check permissions on SUPABASE_HOME and retry.",
                ),
              ),
            );
          const lockDir = path.join(cacheRoot, `.lock-${key}`);
          const pidPath = path.join(lockDir, "pid");
          const acquireLock = Effect.gen(function* () {
            const created = yield* Effect.result(
              fs
                .makeDirectory(lockDir)
                .pipe(
                  Effect.mapError((error) =>
                    shadowError(
                      `Waiting for the isolated shadow baseline cache lock: ${error.message}`,
                      "Retry the command.",
                    ),
                  ),
                ),
            );
            if (created._tag === "Success") {
              yield* fs.writeFileString(pidPath, String(process.pid)).pipe(
                Effect.tapError(() =>
                  fs.remove(lockDir, { recursive: true, force: true }).pipe(Effect.ignore),
                ),
                Effect.mapError((error) =>
                  shadowError(
                    `Failed to write the isolated shadow baseline cache lock: ${error.message}`,
                    "Retry the command.",
                  ),
                ),
              );
              return;
            }
            const holder = Number.parseInt(
              yield* fs.readFileString(pidPath).pipe(Effect.orElseSucceed(() => "")),
              10,
            );
            if (Number.isInteger(holder) && holder > 0 && !isPidAlive(holder)) {
              yield* fs.remove(lockDir, { recursive: true, force: true }).pipe(Effect.ignore);
            }
            return yield* Effect.fail(created.failure);
          });
          yield* retry(acquireLock, LOCK_ATTEMPTS, LOCK_DELAY);
          return yield* effect.pipe(
            Effect.ensuring(
              fs.remove(lockDir, { recursive: true, force: true }).pipe(Effect.ignore),
            ),
          );
        });

      if (cacheEnabled()) {
        yield* withCacheLock(
          Effect.gen(function* () {
            const exists = yield* fs.exists(archivePath).pipe(Effect.orElseSucceed(() => false));
            if (!exists) {
              yield* publishBaseline;
            }
          }),
        );
        yield* requireExitZero(
          ChildProcess.make("tar", ["-xf", archivePath, "-C", dataDir]),
          "Failed to restore the isolated shadow baseline",
        ).pipe(Effect.tapError(() => fs.remove(archivePath, { force: true }).pipe(Effect.ignore)));
        const port = yield* allocatePort;
        yield* startOwnedPostgres(postgresDir, dataDir, port);
        return { url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` };
      }

      const port = yield* allocatePort;
      yield* startOwnedPostgres(postgresDir, dataDir, port);
      yield* applyPlatformBaseline(postgresDir, port, autoExposeNewTables);
      return { url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` };
    }).pipe(Effect.mapError(toShadowError));

    return IsolatedShadowProvisioner.of({ provision });
  }),
);
