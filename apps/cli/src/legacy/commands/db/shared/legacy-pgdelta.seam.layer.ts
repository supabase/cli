import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { spawnContainerCli } from "../../../shared/legacy-container-cli.ts";
import { legacyResolveDbImage } from "../../../shared/legacy-db-image.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import { legacyIsDockerDaemonUnreachable } from "../../../shared/legacy-docker-suggest.ts";
import { legacyIsLocalDbRunning } from "../../../shared/db-bootstrap/local-db-running.ts";
import { legacyStartLocalDatabase } from "../../../shared/db-bootstrap/start-local-database.ts";
import {
  legacyExportBaselineCatalogRef,
  legacyExportDeclarativeCatalogRef,
} from "../../../shared/legacy-pgdelta.cache.ts";
import {
  legacyResolveLocalProjectId,
  localDbContainerId,
} from "../../../shared/legacy-docker-ids.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

const legacyShadowDockerCause = (
  stderr: string,
): { readonly docker: "daemon" } | Record<never, never> =>
  legacyIsDockerDaemonUnreachable(stderr) ? { docker: "daemon" } : {};

/**
 * Whether an underlying failure signals the Docker daemon is unreachable, across every tagged
 * error class this seam composes over — `LegacyShadowDbError.reason === "docker_daemon"`,
 * `LegacyImagePrepullError.reason === "docker_daemon"`, `LegacyLocalDbRunningError.daemonDown`,
 * `LegacyPgDeltaDeclarativeApplyError.reason === "daemon"`, and every `*.docker === "daemon"`
 * field (`LegacyDeclarativeEdgeRuntimeError`, …). Checked structurally rather than per-tag so a
 * new error class in the union doesn't silently drop its own daemon signal.
 */
function legacyHasDaemonSignal(cause: {
  readonly message: string;
  readonly reason?: unknown;
  readonly docker?: unknown;
  readonly daemonDown?: unknown;
}): boolean {
  return (
    cause.reason === "docker_daemon" ||
    cause.reason === "daemon" ||
    cause.docker === "daemon" ||
    cause.daemonDown === true
  );
}

/**
 * Maps any failure from the native shadow-provisioning stack (`legacy-pgdelta.cache.ts`'s
 * `legacyExportBaselineCatalogRef`/`legacyExportDeclarativeCatalogRef`, and everything they
 * compose — shadow create/setup, health checks, the pg-delta edge-runtime scripts, the
 * declarative-apply engine, config loading) into the seam's own
 * {@link LegacyDeclarativeShadowDbError}, carrying the underlying message. Every component error
 * class in that stack declares `message: string`, so this accepts the whole union structurally
 * rather than enumerating each tag.
 */
export const legacyToShadowDbError = (cause: {
  readonly message: string;
  readonly reason?: unknown;
  readonly docker?: unknown;
  readonly daemonDown?: unknown;
  readonly suggestion?: unknown;
}) =>
  new LegacyDeclarativeShadowDbError({
    message: `failed to provision the shadow database: ${cause.message}`,
    ...(legacyHasDaemonSignal(cause) ? { docker: "daemon" as const } : {}),
    ...(typeof cause.suggestion === "string" ? { suggestion: cause.suggestion } : {}),
  });

/**
 * Real `LegacyDeclarativeSeam`: fully native. `exportCatalog` composes the shadow-database
 * platform-baseline/declarative catalog export (`legacy-pgdelta.cache.ts`'s
 * `legacyExportBaselineCatalogRef`/`legacyExportDeclarativeCatalogRef`); `ensureLocalDatabaseStarted`
 * shares the same `legacyStartLocalDatabase` bring-up `db start` uses;
 * `ensureLocalPostgresImageCurrent` was already native (CLI-1956) and is unchanged here.
 */
export const legacyDeclarativeSeamLayer = Layer.effect(
  LegacyDeclarativeSeam,
  Effect.gen(function* () {
    const cliConfig = yield* LegacyCliConfig;
    const spawner = yield* ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Captures every OTHER service `legacyExportBaselineCatalogRef`/
    // `legacyExportDeclarativeCatalogRef`/`legacyStartLocalDatabase` need internally (Output,
    // RuntimeInfo, HttpClient, LegacyDbConnection, LegacyEdgeRuntimeScript, LegacyDockerRun,
    // LegacyPgDeltaSslProbe, LegacyNetworkIdFlag, the `--experimental`/CliArgs global-flag
    // machinery, …) into a plain `Context` so each closure below can `Effect.provideContext` it
    // and satisfy `LegacyDeclarativeSeamShape`'s `Effect<T, E>` (no leftover requirements)
    // without hand-enumerating every transitive dependency — mirrors
    // `legacy-platform-api-factory.layer.ts`'s identical capture-and-provide shape.
    const context = yield* Effect.context<
      | LegacyExportBaselineCatalogDeps
      | LegacyExportDeclarativeCatalogDeps
      | LegacyStartLocalDatabaseDeps
    >();

    return LegacyDeclarativeSeam.of({
      exportCatalog: ({ mode, noCache, projectRef }) =>
        (mode === "baseline"
          ? legacyExportBaselineCatalogRef(fs, path, cliConfig.workdir, cliConfig.projectId, {
              noCache,
              projectRef,
            })
          : legacyExportDeclarativeCatalogRef(fs, path, cliConfig.workdir, cliConfig.projectId, {
              noCache,
              projectRef,
            })
        ).pipe(
          Effect.provideContext(context),
          Effect.catch((cause) => Effect.fail(legacyToShadowDbError(cause))),
        ),
      ensureLocalDatabaseStarted: () =>
        Effect.gen(function* () {
          const running = yield* legacyIsLocalDbRunning(
            spawner,
            fs,
            path,
            cliConfig.workdir,
            Option.getOrUndefined(cliConfig.projectId),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new LegacyDeclarativeShadowDbError({
                  message: cause.message,
                  ...(cause.daemonDown === true ? { docker: "daemon" as const } : {}),
                  // Same propagation as the start-failure catch below: the inspect error's
                  // Docker-install recovery text (Go's `utils.CmdSuggestion`) must survive the
                  // seam, or the normalizer falls back to its generic debug hint.
                  ...(cause.suggestion !== undefined ? { suggestion: cause.suggestion } : {}),
                }),
            ),
          );
          if (running) return; // already running — the seam never prints anything here.
          yield* legacyStartLocalDatabase().pipe(
            Effect.provideContext(context),
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message: `failed to start local database: ${cause.message}`,
                  ...(legacyHasDaemonSignal(cause) ? { docker: "daemon" as const } : {}),
                  ...("suggestion" in cause && typeof cause.suggestion === "string"
                    ? { suggestion: cause.suggestion }
                    : {}),
                }),
              ),
            ),
          );
        }),
      ensureLocalPostgresImageCurrent: () =>
        Effect.scoped(
          Effect.gen(function* () {
            const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir).pipe(
              Effect.mapError(
                (error) =>
                  new LegacyDeclarativeShadowDbError({
                    message: `failed to read config for local Postgres image check: ${error.message}`,
                  }),
              ),
            );
            const image = yield* legacyResolveDbImage(
              fs,
              path,
              cliConfig.workdir,
              toml.majorVersion,
              Option.getOrUndefined(toml.orioledbVersion),
            );
            const tomlProjectId = toml.projectId;
            const projectId = legacyResolveLocalProjectId(
              Option.getOrUndefined(cliConfig.projectId),
              Option.getOrUndefined(tomlProjectId),
              cliConfig.workdir,
            );
            const containerId = localDbContainerId(projectId);
            const child = yield* spawnContainerCli(spawner, ["container", "inspect", containerId], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              extendEnv: true,
            }).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            const stdoutChunks: Array<Uint8Array> = [];
            const stderrChunks: Array<Uint8Array> = [];
            yield* Stream.runForEach(child.stdout, (chunk) =>
              Effect.sync(() => {
                stdoutChunks.push(chunk);
              }),
            ).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            yield* Stream.runForEach(child.stderr, (chunk) =>
              Effect.sync(() => {
                stderrChunks.push(chunk);
              }),
            ).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            const inspectExit = yield* child.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            const decodeChunks = (chunks: ReadonlyArray<Uint8Array>): string => {
              const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
              const bytes = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
              return new TextDecoder().decode(bytes).trim();
            };
            const stderr = decodeChunks(stderrChunks);
            const stdout = decodeChunks(stdoutChunks);
            if (inspectExit !== 0) {
              if (legacyIsMissingContainerInspectError(stderr)) return;
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message:
                    stderr.length > 0
                      ? `failed to inspect local Postgres container: ${stderr}`
                      : "failed to inspect local Postgres container.",
                  ...legacyShadowDockerCause(stderr),
                }),
              );
            }
            const actual = legacyResolveContainerInspectImageName(stdout);
            const expected = legacyGetRegistryImageUrl(image).trim();
            const actualTag = dockerImageTag(actual);
            const expectedTag = dockerImageTag(expected);
            if (actualTag.length === 0 || expectedTag.length === 0 || actualTag === expectedTag) {
              return;
            }
            return yield* Effect.fail(
              new LegacyDeclarativeShadowDbError({
                message: `local Postgres container image is stale: running ${actual} but expected ${expected}. Run supabase stop --all --no-backup, then supabase start before syncing declarative schemas.`,
              }),
            );
          }),
        ),
    });
  }),
);

type LegacyExportBaselineCatalogDeps =
  ReturnType<typeof legacyExportBaselineCatalogRef> extends Effect.Effect<
    infer _A,
    infer _E,
    infer R
  >
    ? R
    : never;

type LegacyExportDeclarativeCatalogDeps =
  ReturnType<typeof legacyExportDeclarativeCatalogRef> extends Effect.Effect<
    infer _A,
    infer _E,
    infer R
  >
    ? R
    : never;

type LegacyStartLocalDatabaseDeps =
  ReturnType<typeof legacyStartLocalDatabase> extends Effect.Effect<infer _A, infer _E, infer R>
    ? R
    : never;

function dockerImageTag(image: string): string {
  const trimmed = image.trim();
  const index = trimmed.lastIndexOf(":");
  if (index < 0 || index === trimmed.length - 1) return "";
  return trimmed.slice(index + 1);
}

export function legacyIsMissingContainerInspectError(stderr: string): boolean {
  return stderr.toLowerCase().includes("no such container");
}

export function legacyResolveContainerInspectImageName(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  const inspect = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isJsonRecord(inspect)) return "";
  const imageName = inspect["ImageName"];
  if (typeof imageName === "string" && imageName.trim().length > 0) {
    return imageName.trim();
  }
  const config = inspect["Config"];
  if (!isJsonRecord(config)) return "";
  const configImage = config["Image"];
  return typeof configImage === "string" && configImage.trim().length > 0 ? configImage.trim() : "";
}

function isJsonRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}
