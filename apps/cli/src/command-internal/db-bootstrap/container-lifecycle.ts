/**
 * Given a fully-resolved {@link StartContainerSpec}, sets the two project-identity labels,
 * provisions the container's own named volumes, builds the `docker create` argv, spawns `docker
 * create`, copies any `secretFiles` in via `docker cp` (see
 * {@link copyStartSecretFilesIntoContainer}), then spawns `docker start`.
 *
 * Network creation is not part of this per-container function; see {@link ensureNetwork} for why
 * it runs once instead of once per container.
 */

import { Data, Effect, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import {
  collectText,
  containerCliExitCode,
  describeContainerCliFailure,
  runContainerCliExpectSuccess,
  spawnContainerCli,
} from "../container-cli.ts";
import { bindMountSpecSource, isBindMountSource } from "../docker-bind-classify.ts";
import { CLI_PROJECT_LABEL, CLI_WORKDIR_LABEL } from "../docker-ids.ts";
import { isDockerDaemonUnreachable } from "../docker-suggest.ts";
import {
  containerArchiveBytes,
  isUserDefinedDockerNetwork,
} from "../../shared/functions/functions-docker.ts";
import {
  buildStartContainerCreateArgs,
  applyBitbucketStartContainerFilter,
  isDockerClientEnvKey,
  type StartContainerSpec,
} from "./docker-create-args.ts";

type StartSecretFileSpec = NonNullable<StartContainerSpec["secretFiles"]>[number];

type StartPreStartArchiveSpec = NonNullable<StartContainerSpec["preStartArchives"]>[number];

type Spawner = ChildProcessSpawner["Service"];

/**
 * Set unconditionally on every container, even though this CLI doesn't integrate with
 * docker-compose: external tooling that groups/filters containers by this label (Docker
 * Desktop's Compose view, `docker compose ls`, the VS Code Docker extension) would otherwise
 * stop recognizing the local stack's containers.
 */
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

type ContainerOperationReason = "runtime" | "configuration" | "internal" | "port_conflict";

function containerOperationActionability(
  reason: ContainerOperationReason | undefined,
): CliErrorActionabilityDeclaration {
  switch (reason) {
    case "runtime":
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    case "internal":
      return actionability.internalPanic;
    case "port_conflict":
      return { ...actionability.invalidConfig, fingerprint_suffix: "port_conflict" };
    default:
      return { ...actionability.invalidConfig, fingerprint_suffix: "container_configuration" };
  }
}

function containerCliReason(message: string): "runtime" | "configuration" {
  return isDockerDaemonUnreachable(message) ? "runtime" : "configuration";
}

/** `docker network create --label ...`/`docker volume create --label ...` failed. */
export class NetworkCreateError extends Data.TaggedError("NetworkCreateError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return containerOperationActionability(this.reason);
  }
}

export class VolumeCreateError extends Data.TaggedError("VolumeCreateError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return containerOperationActionability(this.reason);
  }
}

/** `docker create` failed. */
export class ContainerCreateError extends Data.TaggedError("ContainerCreateError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration" | "internal";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return containerOperationActionability(this.reason);
  }
}

/** `docker start` failed — see {@link portConflictSuggestion} for the port-already-allocated case. */
export class ContainerStartError extends Data.TaggedError("ContainerStartError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration" | "port_conflict";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return containerOperationActionability(this.reason);
  }
}

/** Every failure {@link createContainer} itself can produce (network creation is separate, see {@link ensureNetwork}). */
export type ContainerError = VolumeCreateError | ContainerCreateError | ContainerStartError;

export interface ContainerOpts {
  /**
   * Merged onto both {@link CLI_PROJECT_LABEL} and {@link COMPOSE_PROJECT_LABEL}, overwriting
   * any value the caller already set for those keys in `spec.labels`.
   */
  readonly projectId: string;
  /** Passed in (rather than read via env here) so this module stays a pure effect orchestrator. */
  readonly isBitbucketPipeline: boolean;
  /**
   * Stamped onto every created container as {@link CLI_WORKDIR_LABEL} so a later `stop` or
   * {@link rollbackStart} can find this directory from the container's own label alone, without
   * depending on the invoking cwd/`--workdir` matching `start`'s.
   *
   * `cleanupStartSecrets` also uses this label to reclaim other host-persisted staging under this
   * project (e.g. Edge Runtime's env-file staging) once a container is torn down.
   */
  readonly workdir: string;
  /**
   * Merged onto every container's `HostConfig.ExtraHosts`. Linux-only
   * (`["host.docker.internal:host-gateway"]`); empty on Docker Desktop platforms, which already
   * resolve that hostname natively.
   */
  readonly extraHosts: ReadonlyArray<string>;
}

/**
 * Extracts every named-volume source from `binds` (`source:target[:mode]`; see
 * `docker-create-args.ts`'s `StartContainerSpec.binds` doc comment). A source is a named volume
 * exactly when {@link isBindMountSource} says it is not a bind-mount path. Not deduped —
 * `docker volume create` is idempotent for a repeated name.
 */
function namedVolumeSources(binds: ReadonlyArray<string>): ReadonlyArray<string> {
  const sources: Array<string> = [];
  for (const bind of binds) {
    const source = bindMountSpecSource(bind);
    if (source.length > 0 && !isBindMountSource(source)) {
      sources.push(source);
    }
  }
  return sources;
}

/**
 * Whether `docker`/`podman network create`'s stderr reports the network already existing.
 * Docker's message is "network with name <id> already exists"; Podman's is "network name <id>
 * already used" — hence the broader pattern instead of matching Docker's exact wording.
 */
function isNetworkAlreadyExistsError(stderr: string): boolean {
  return /already exists|already used/iu.test(stderr);
}

/** Matches Docker's "port is already allocated" bind error, capturing the port spec. */
const PORT_BIND_ERROR_PATTERN = /Bind for (.*) failed: port is already allocated/;

function parsePortBindError(stderr: string): string | undefined {
  return PORT_BIND_ERROR_PATTERN.exec(stderr)?.[1];
}

/**
 * Suggests fixes for a "port already allocated" failure without inspecting every running
 * container to identify the specific owner — disproportionate plumbing for a hint — folding both
 * possible causes into one still-actionable sentence.
 */
function portConflictSuggestion(hostPort: string, serviceLabel: string): string {
  return (
    `\nTry stopping the project or container already using ${hostPort} ` +
    "(`docker ps` lists what's bound to it, or `supabase stop` for another local Supabase project), " +
    `or configure a different ${serviceLabel} port in supabase/config.toml.`
  );
}

/**
 * Creates the shared docker network for this project via `docker network create --label ...`,
 * treating "already exists" as success.
 *
 * Called once per `start` run rather than once per container: the network can't be deleted
 * externally mid-run, so it's guaranteed to still exist for every later {@link createContainer}
 * call. Returns immediately for a built-in network name (`default`, `bridge`, `host`, `none`),
 * which already exists and cannot be created.
 */
export function ensureNetwork(
  spawner: Spawner,
  networkId: string,
  labels: Readonly<Record<string, string>>,
): Effect.Effect<void, NetworkCreateError> {
  if (!isUserDefinedDockerNetwork(networkId)) {
    return Effect.void;
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const inspectExitCode = yield* containerCliExitCode(
        spawner,
        ["network", "inspect", networkId],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      ).pipe(Effect.orElseSucceed(() => 1));
      if (inspectExitCode === 0) {
        return;
      }
      const args = [
        "network",
        "create",
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        networkId,
      ];
      const child = yield* spawnContainerCli(spawner, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new NetworkCreateError({
              message: `failed to create docker network: ${describeContainerCliFailure(cause)}`,
              reason: "runtime",
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new NetworkCreateError({
              message: "failed to create docker network",
              reason: "runtime",
            }),
        ),
      );
      if (exitCode !== 0 && !isNetworkAlreadyExistsError(stderr)) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new NetworkCreateError({
            message:
              message.length > 0
                ? `failed to create docker network: ${message}`
                : "failed to create docker network",
            reason: containerCliReason(message),
          }),
        );
      }
    }),
  );
}

/**
 * Whether `volume create`'s stderr reports the volume already existing (Podman's "volume with
 * name <name> already exists: volume already exists", matching either half). A "...but was not
 * created for the current specification" conflict does not match, so a real spec conflict still
 * fails.
 */
function isVolumeAlreadyExistsError(stderr: string): boolean {
  return /volume (?:with name \S+ )?already exists/iu.test(stderr);
}

/**
 * Creates a named volume via `docker volume create --label ...`, treating "already exists" as
 * success, the same way {@link ensureNetwork} does; any other non-zero exit is a real failure.
 *
 * Podman's `volume create` (unlike Docker's) is not idempotent for a repeated name and rejects it
 * outright, which would otherwise abort a `start` on volumes an earlier `stop` preserved.
 */
export function ensureVolume(
  spawner: Spawner,
  name: string,
  labels: Readonly<Record<string, string>>,
): Effect.Effect<void, VolumeCreateError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const args = [
        "volume",
        "create",
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        name,
      ];
      const child = yield* spawnContainerCli(spawner, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new VolumeCreateError({
              message: `failed to create volume: ${describeContainerCliFailure(cause)}`,
              reason: "runtime",
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new VolumeCreateError({
              message: "failed to create volume",
              reason: "runtime",
            }),
        ),
      );
      if (exitCode !== 0 && !isVolumeAlreadyExistsError(stderr)) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new VolumeCreateError({
            message:
              message.length > 0
                ? `failed to create volume: ${message}`
                : "failed to create volume",
            reason: containerCliReason(message),
          }),
        );
      }
    }),
  );
}

/** `docker volume inspect` failed to spawn at all (no docker/podman binary). */
export class VolumeInspectError extends Data.TaggedError("VolumeInspectError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** Docker's/Podman's "no such volume" stderr shape for `volume inspect`. */
function isVolumeNotFoundMessage(message: string): boolean {
  return /no such volume/iu.test(message);
}

/**
 * Runs before the volume is created (creation is idempotent, so creating first would lose
 * whether it already existed). A confirmed "no such volume" resolves to `false`; any other
 * inspect failure resolves to `true` instead, so an ambiguous failure never lets
 * {@link rollbackStart} prune a volume that may hold real prior data. Separate from
 * {@link ensureVolume}, which must keep its own idempotent-create behavior unchanged.
 */
export function volumeExists(
  spawner: Spawner,
  name: string,
): Effect.Effect<boolean, VolumeInspectError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["volume", "inspect", name], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new VolumeInspectError({
              message: `failed to inspect volume: ${describeContainerCliFailure(cause)}`,
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(() => new VolumeInspectError({ message: "failed to inspect volume" })),
      );
      if (exitCode === 0) return true;
      return !isVolumeNotFoundMessage(stderr);
    }),
  );
}

/** `docker container rm -f <id>` (or `docker rm -f`) failed. */
export class ContainerRemoveError extends Data.TaggedError("ContainerRemoveError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return containerOperationActionability(this.reason);
  }
}

/**
 * Removes a container via `docker container rm -f <id>`. Any non-zero exit is a real failure —
 * unlike other container lookups here, a missing container is not swallowed into success.
 * `-f` alone (no `-v`); the paired named volume is removed separately by {@link removeVolume}.
 */
export function removeContainer(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<void, ContainerRemoveError> {
  return runContainerCliExpectSuccess(
    spawner,
    ["container", "rm", "-f", containerId],
    "remove container",
    (message) => new ContainerRemoveError({ message, reason: containerCliReason(message) }),
  );
}

/** `docker volume rm -f <name>` failed. */
export class VolumeRemoveError extends Data.TaggedError("VolumeRemoveError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return containerOperationActionability(this.reason);
  }
}

/**
 * Removes a volume via `docker volume rm -f <name>`. `force` makes removing an already-missing
 * volume a no-op, so — unlike {@link removeContainer} — no special-casing is needed here: any
 * non-zero exit is a genuine failure.
 */
export function removeVolume(
  spawner: Spawner,
  volumeName: string,
): Effect.Effect<void, VolumeRemoveError> {
  return runContainerCliExpectSuccess(
    spawner,
    ["volume", "rm", "-f", volumeName],
    "remove volume",
    (message) => new VolumeRemoveError({ message, reason: containerCliReason(message) }),
  );
}

function dockerCreateContainer(
  spawner: Spawner,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Effect.Effect<string, ContainerCreateError> {
  return Effect.scoped(
    Effect.gen(function* () {
      // `docker-create-args.ts` emits the key-only `-e KEY` form (never `-e KEY=value`) so
      // secrets never appear in argv/`ps`/`/proc/<pid>/cmdline`; Docker resolves each key's value
      // from this spawned process's own environment instead. `extendEnv: true` keeps the rest of
      // the parent's env (PATH, the real DOCKER_HOST, …) while `env` supplies the secret values.
      //
      // Callers must already have stripped `isDockerClientEnvKey` keys (e.g. a container-facing
      // `DOCKER_HOST`) from `env` — those go inline as `-e KEY=value` instead, since merging one
      // in here would hijack which daemon this `docker create` call itself talks to.
      const child = yield* spawnContainerCli(spawner, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
        extendEnv: true,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ContainerCreateError({
              message: `failed to create docker container: ${describeContainerCliFailure(cause)}`,
              reason: "runtime",
            }),
        ),
      );
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          collectText(child.stdout),
          collectText(child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new ContainerCreateError({
              message: "failed to create docker container",
              reason: "runtime",
            }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new ContainerCreateError({
            message:
              message.length > 0
                ? `failed to create docker container: ${message}`
                : "failed to create docker container",
            reason: containerCliReason(message),
          }),
        );
      }
      return stdout.trim();
    }),
  );
}

function dockerStartContainer(
  spawner: Spawner,
  containerId: string,
  spec: StartContainerSpec,
): Effect.Effect<void, ContainerStartError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["start", containerId], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ContainerStartError({
              message: `failed to start docker container "${spec.containerName}": ${describeContainerCliFailure(cause)}`,
              reason: "runtime",
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new ContainerStartError({
              message: `failed to start docker container "${spec.containerName}"`,
              reason: "runtime",
            }),
        ),
      );
      if (exitCode !== 0) {
        const trimmed = stderr.trim();
        const base = `failed to start docker container "${spec.containerName}": ${
          trimmed.length > 0 ? trimmed : `exit ${exitCode}`
        }`;
        const hostPort = parsePortBindError(trimmed);
        if (hostPort === undefined) {
          return yield* Effect.fail(
            new ContainerStartError({
              message: base,
              reason: containerCliReason(trimmed),
            }),
          );
        }
        const serviceLabel = spec.networkAliases?.[0] ?? spec.containerName;
        return yield* Effect.fail(
          new ContainerStartError({
            message: `${base}${portConflictSuggestion(hostPort, serviceLabel)}`,
            reason: "port_conflict",
          }),
        );
      }
    }),
  );
}

/**
 * `docker cp - <dest>` with tar bytes on stdin. The stream form keeps member uid/gid;
 * a host-path copy would reset ownership to root.
 */
export function dockerCopyArchiveIntoContainer<E>(
  spawner: Spawner,
  archive: Uint8Array | StartPreStartArchiveSpec["tar"],
  containerDest: string,
  fail: (detail: string) => E,
): Effect.Effect<void, E> {
  const stdin = Stream.isStream(archive) ? archive : Stream.make(archive);
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["cp", "-", containerDest], {
        stdin,
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(Effect.mapError((cause) => fail(describeContainerCliFailure(cause))));
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((cause) => fail(describeContainerCliFailure(cause))));
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          fail(message.length > 0 ? `exit ${exitCode}: ${message}` : `exit ${exitCode}`),
        );
      }
    }),
  );
}

const secretCopyFailure = (detail: string): ContainerCreateError =>
  new ContainerCreateError({
    message:
      detail.length > 0
        ? `failed to create docker container: failed to copy secret file into container: ${detail}`
        : "failed to create docker container: failed to copy secret file into container",
    reason: detail.length > 0 && !isDockerDaemonUnreachable(detail) ? "configuration" : "runtime",
  });

/**
 * Streams all secret files as one archive after create and before start. `Bun.Archive` exposes
 * no per-entry mode option, so the unit test pins its `0644` default, which keeps the files
 * readable by non-root Kong/Postgres processes. Once copied, the files live in the container
 * filesystem, so normal restarts need no host artifact.
 */
function copyStartSecretFilesIntoContainer(
  spawner: Spawner,
  containerId: string,
  secretFiles: ReadonlyArray<StartSecretFileSpec>,
): Effect.Effect<void, ContainerCreateError> {
  if (secretFiles.length === 0) return Effect.void;

  return Effect.tryPromise({
    try: () =>
      containerArchiveBytes(
        Object.fromEntries(
          secretFiles.map((secretFile) => [secretFile.containerPath, secretFile.content]),
        ),
      ),
    catch: (cause) =>
      new ContainerCreateError({
        message: `failed to create docker container: failed to prepare container secret files: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        reason: "internal",
      }),
  }).pipe(
    Effect.flatMap((archive) =>
      dockerCopyArchiveIntoContainer(spawner, archive, `${containerId}:/`, secretCopyFailure),
    ),
  );
}

/**
 * `docker cp - <containerId>:<containerPath>` for one {@link StartContainerSpec.preStartArchives}
 * entry — the form that preserves each archive member's uid/gid; the host-path form resets
 * ownership to root, which a restored Postgres data directory cannot survive.
 *
 * Sequenced by {@link createContainer} between `docker create` and `docker start`: the container
 * must exist for `docker cp` to have a target and must not be running yet, since the entrypoint's
 * behavior depends on what it finds already unpacked.
 */
function extractPreStartArchiveIntoContainer(
  spawner: Spawner,
  containerId: string,
  archive: StartPreStartArchiveSpec,
): Effect.Effect<void, ContainerCreateError> {
  return dockerCopyArchiveIntoContainer(
    spawner,
    archive.tar,
    `${containerId}:${archive.containerPath}`,
    (detail) =>
      new ContainerCreateError({
        message: `failed to create docker container: failed to restore archive into container: ${detail}`,
        reason: "runtime",
      }),
  );
}

/**
 * Provisions this container's named volumes (skipped under Bitbucket Pipelines), creates it,
 * copies any `secretFiles` and `preStartArchives` in via `docker cp` while it's created but not
 * yet running (so its entrypoint never races the copy), then starts it.
 *
 * Resolves to the created container's id/name on success.
 */
export function createContainer(
  spawner: Spawner,
  spec: StartContainerSpec,
  opts: ContainerOpts,
): Effect.Effect<string, ContainerError> {
  return Effect.gen(function* () {
    const labels: Record<string, string> = {
      ...spec.labels,
      [CLI_PROJECT_LABEL]: opts.projectId,
      [COMPOSE_PROJECT_LABEL]: opts.projectId,
    };
    // The workdir label goes on the container only, not its named volumes below: a volume's name
    // already carries the project id, and nothing reads a workdir label back off a volume.
    const containerLabels: Record<string, string> = {
      ...labels,
      [CLI_WORKDIR_LABEL]: opts.workdir,
    };
    const labeledSpec: StartContainerSpec = {
      ...spec,
      labels: containerLabels,
      extraHosts: [...(spec.extraHosts ?? []), ...opts.extraHosts],
    };

    if (!opts.isBitbucketPipeline) {
      for (const name of namedVolumeSources(labeledSpec.binds)) {
        yield* ensureVolume(spawner, name, labels);
      }
    }

    const finalSpec = applyBitbucketStartContainerFilter(labeledSpec, opts.isBitbucketPipeline);

    const createArgs = buildStartContainerCreateArgs(finalSpec);
    // `isDockerClientEnvKey` keys are already emitted inline as `-e KEY=value` above; see
    // `dockerCreateContainer` for why they must not also reach this process's own environment.
    const createProcessEnv = Object.fromEntries(
      Object.entries(finalSpec.env).filter(([key]) => !isDockerClientEnvKey(key)),
    );
    const containerId = yield* dockerCreateContainer(spawner, createArgs, createProcessEnv);
    yield* copyStartSecretFilesIntoContainer(spawner, containerId, finalSpec.secretFiles ?? []);
    // Sequential, not concurrent like the secret files: archives can legitimately overlap in the
    // container's filesystem, so the spec's own order must be the applied order.
    //
    // A failed extraction removes the just-created container first (unlike a secret-file or
    // `docker start` failure, which leave cleanup to the caller's finalizer): this step's one
    // producer, the shadow baseline cache's warm restore, retries by provisioning a replacement
    // container, and must not leak an orphaned one per retry.
    yield* Effect.forEach(
      finalSpec.preStartArchives ?? [],
      (archive) => extractPreStartArchiveIntoContainer(spawner, containerId, archive),
      { discard: true },
    ).pipe(
      Effect.tapError(() =>
        containerCliExitCode(spawner, ["rm", "-f", "-v", containerId], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }).pipe(Effect.orElseSucceed(() => 0)),
      ),
    );
    yield* dockerStartContainer(spawner, containerId, finalSpec);
    return containerId;
  });
}
