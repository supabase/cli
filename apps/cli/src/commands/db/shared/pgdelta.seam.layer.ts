import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { spawnContainerCli } from "../../../command-internal/container-cli.ts";
import { resolveDbImage } from "../../../command-internal/db-image.ts";
import { readDbToml } from "../../../command-internal/db-config.toml-read.ts";
import { getRegistryImageUrl } from "../../../command-internal/docker-registry.ts";
import { isDockerDaemonUnreachable } from "../../../command-internal/docker-suggest.ts";
import { isSlimImageRef } from "../../../shared/services/slim-images.ts";
import { isLocalDbRunning } from "../../../command-internal/db-bootstrap/local-db-running.ts";
import { startLocalDatabase } from "../../../command-internal/db-bootstrap/start-local-database.ts";
import { resolveLocalProjectId, localDbContainerId } from "../../../command-internal/docker-ids.ts";
import { DeclarativeShadowDbError } from "./pgdelta.errors.ts";
import { DeclarativeSeam } from "./pgdelta.seam.service.ts";

const shadowDockerCause = (stderr: string): { readonly docker: "daemon" } | Record<never, never> =>
  isDockerDaemonUnreachable(stderr) ? { docker: "daemon" } : {};

/**
 * Whether an underlying failure signals the Docker daemon is unreachable, across every tagged
 * error class this seam composes over. Checked structurally (`reason`/`docker`/`daemonDown`
 * fields) rather than per-tag, so a new error class in the union can't silently drop its own
 * daemon signal.
 */
function hasDaemonSignal(cause: {
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
 * Maps any failure from the native local-database bring-up stack into the seam's own
 * {@link DeclarativeShadowDbError}. Every component error class declares `message: string`, so
 * this accepts the whole union structurally rather than enumerating each tag.
 */
export const toShadowDbError = (cause: {
  readonly message: string;
  readonly reason?: unknown;
  readonly docker?: unknown;
  readonly daemonDown?: unknown;
  readonly suggestion?: unknown;
}) =>
  new DeclarativeShadowDbError({
    message: `failed to provision the shadow database: ${cause.message}`,
    ...(hasDaemonSignal(cause) ? { docker: "daemon" as const } : {}),
    ...(typeof cause.suggestion === "string" ? { suggestion: cause.suggestion } : {}),
  });

/**
 * Real `DeclarativeSeam`: fully native. `ensureLocalDatabaseStarted` shares the same
 * `startLocalDatabase` bring-up `db start` uses.
 */
export const declarativeSeamLayer = Layer.effect(
  DeclarativeSeam,
  Effect.gen(function* () {
    const cliSettings = yield* CommandSettings;
    const spawner = yield* ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Captures every service `startLocalDatabase` needs into a plain `Context`, so each
    // closure below can `Effect.provideContext` it and satisfy `DeclarativeSeamShape` without
    // hand-enumerating every transitive dependency.
    const context = yield* Effect.context<StartLocalDatabaseDeps>();

    return DeclarativeSeam.of({
      ensureLocalDatabaseStarted: () =>
        Effect.gen(function* () {
          const running = yield* isLocalDbRunning(
            spawner,
            fs,
            path,
            cliSettings.workdir,
            Option.getOrUndefined(cliSettings.projectId),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new DeclarativeShadowDbError({
                  message: cause.message,
                  ...(cause.daemonDown === true ? { docker: "daemon" as const } : {}),
                  // The inspect error's Docker-install recovery text must survive the seam, or
                  // the normalizer falls back to its generic debug hint.
                  ...(cause.suggestion !== undefined ? { suggestion: cause.suggestion } : {}),
                }),
            ),
          );
          if (running) return; // already running — the seam never prints anything here.
          yield* startLocalDatabase().pipe(
            Effect.provideContext(context),
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.fail(
                new DeclarativeShadowDbError({
                  message: `failed to start local database: ${cause.message}`,
                  ...(hasDaemonSignal(cause) ? { docker: "daemon" as const } : {}),
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
            const toml = yield* readDbToml(fs, path, cliSettings.workdir).pipe(
              Effect.mapError(
                (error) =>
                  new DeclarativeShadowDbError({
                    message: `failed to read config for local Postgres image check: ${error.message}`,
                  }),
              ),
            );
            const { image } = yield* resolveDbImage(
              fs,
              path,
              cliSettings.workdir,
              toml.majorVersion,
              Option.getOrUndefined(toml.orioledbVersion),
            );
            const tomlProjectId = toml.projectId;
            const projectId = resolveLocalProjectId(
              Option.getOrUndefined(cliSettings.projectId),
              Option.getOrUndefined(tomlProjectId),
              cliSettings.workdir,
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
                  new DeclarativeShadowDbError({
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
                  new DeclarativeShadowDbError({
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
                  new DeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            const inspectExit = yield* child.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(
                () =>
                  new DeclarativeShadowDbError({
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
              if (isMissingContainerInspectError(stderr)) return;
              return yield* Effect.fail(
                new DeclarativeShadowDbError({
                  message:
                    stderr.length > 0
                      ? `failed to inspect local Postgres container: ${stderr}`
                      : "failed to inspect local Postgres container.",
                  ...shadowDockerCause(stderr),
                }),
              );
            }
            const actual = resolveContainerInspectImageName(stdout);
            const expected = getRegistryImageUrl(image).trim();
            const actualTag = dockerImageTag(actual);
            const expectedTag = dockerImageTag(expected);
            if (actual.length === 0 || actualTag.length === 0 || expectedTag.length === 0) {
              return;
            }
            // Slim refs never go through a registry mirror, so a family mismatch
            // (e.g. a docker.io container satisfying a ghcr.io/supabase/cli
            // expectation) is stale even when the tags happen to match.
            const familyMismatch = isSlimImageRef(expected) !== isSlimImageRef(actual);
            if (!familyMismatch && actualTag === expectedTag) {
              return;
            }
            const remediation =
              familyMismatch && actualTag === expectedTag
                ? "The tags match but the image family does not (slim vs docker.io). Run supabase stop, then supabase start with the same SUPABASE_USE_SLIM_IMAGES setting before syncing declarative schemas."
                : "Run supabase stop --all --no-backup, then supabase start before syncing declarative schemas.";
            return yield* Effect.fail(
              new DeclarativeShadowDbError({
                message: `local Postgres container image is stale: running ${actual} but expected ${expected}. ${remediation}`,
              }),
            );
          }),
        ),
    });
  }),
);

type StartLocalDatabaseDeps =
  ReturnType<typeof startLocalDatabase> extends Effect.Effect<infer _A, infer _E, infer R>
    ? R
    : never;

function dockerImageTag(image: string): string {
  const trimmed = image.trim();
  const index = trimmed.lastIndexOf(":");
  if (index < 0 || index === trimmed.length - 1) return "";
  return trimmed.slice(index + 1);
}

export function isMissingContainerInspectError(stderr: string): boolean {
  return stderr.toLowerCase().includes("no such container");
}

export function resolveContainerInspectImageName(stdout: string): string {
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
