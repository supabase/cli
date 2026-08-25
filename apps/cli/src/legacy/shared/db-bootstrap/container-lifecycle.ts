/**
 * Port of Go's `DockerStart` (`apps/cli-go/internal/utils/docker.go:363-440`):
 * given a fully-resolved {@link LegacyStartContainerSpec} (image already
 * resolved by `image-prepull.ts` — see its doc comment), sets the two
 * project-identity labels, provisions this container's own named volumes,
 * builds the `docker create` argv (`docker-create-args.ts`), spawns `docker
 * create`, copies any `secretFiles` into the just-created container via
 * `docker cp` (see {@link legacyCopyStartSecretFilesIntoContainer}), then
 * spawns `docker start`.
 *
 * Network creation (`DockerNetworkCreateIfNotExists`) is deliberately NOT part
 * of this per-container function — see {@link legacyEnsureNetwork}'s doc
 * comment for why it is hoisted to run once instead of once per container.
 */

import { Data, Effect, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import {
  legacyCollectText,
  containerCliExitCode,
  legacyDescribeContainerCliFailure,
  legacyRunContainerCliExpectSuccess,
  spawnContainerCli,
} from "../legacy-container-cli.ts";
import {
  legacyBindMountSpecSource,
  legacyIsBindMountSource,
} from "../legacy-docker-bind-classify.ts";
import { LEGACY_CLI_PROJECT_LABEL, LEGACY_CLI_WORKDIR_LABEL } from "../legacy-docker-ids.ts";
import { legacyIsDockerDaemonUnreachable } from "../legacy-docker-suggest.ts";
import {
  containerArchiveBytes,
  isUserDefinedDockerNetwork,
} from "../../../shared/functions/functions-docker.ts";
import {
  legacyBuildStartContainerCreateArgs,
  legacyApplyBitbucketStartContainerFilter,
  legacyIsDockerClientEnvKey,
  type LegacyStartContainerSpec,
} from "./docker-create-args.ts";

/** Structural element type of {@link LegacyStartContainerSpec.secretFiles} — not exported from `docker-create-args.ts`, so referenced positionally here. */
type LegacyStartSecretFileSpec = NonNullable<LegacyStartContainerSpec["secretFiles"]>[number];

/** Structural element type of {@link LegacyStartContainerSpec.preStartArchives} — same reasoning as {@link LegacyStartSecretFileSpec}. */
type LegacyStartPreStartArchiveSpec = NonNullable<
  LegacyStartContainerSpec["preStartArchives"]
>[number];

type Spawner = ChildProcessSpawner["Service"];

/**
 * Go's `composeProjectLabel` (`apps/cli-go/internal/utils/docker.go:60`,
 * unexported there). This port does not integrate with docker-compose
 * anywhere (an intentional architecture decision), but the label is still set
 * unconditionally, matching Go's own unconditional assignment
 * (`docker.go:376`) regardless of whether compose is actually in use: external
 * tooling that groups/filters containers by this label (Docker Desktop's
 * Compose view, `docker compose ls`, the VS Code Docker extension) would
 * otherwise silently stop recognizing the local stack's containers.
 *
 * A same-value private constant already exists at
 * `shared/functions/functions-docker.ts` (`dockerComposeProjectLabel`, for the
 * unrelated `functions deploy`/`functions serve` Docker Desktop extension
 * gateway) but is neither exported nor in the same Docker-usage domain as
 * `start` — not hoisted from there.
 */
export const LEGACY_COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

type LegacyContainerOperationReason = "runtime" | "configuration" | "internal" | "port_conflict";

function legacyContainerOperationActionability(
  reason: LegacyContainerOperationReason | undefined,
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

function legacyContainerCliReason(message: string): "runtime" | "configuration" {
  return legacyIsDockerDaemonUnreachable(message) ? "runtime" : "configuration";
}

/** `docker network create --label ...`/`docker volume create --label ...` failed. */
export class LegacyNetworkCreateError extends Data.TaggedError("LegacyNetworkCreateError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return legacyContainerOperationActionability(this.reason);
  }
}

export class LegacyVolumeCreateError extends Data.TaggedError("LegacyVolumeCreateError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return legacyContainerOperationActionability(this.reason);
  }
}

/** `docker create` failed. */
export class LegacyContainerCreateError extends Data.TaggedError("LegacyContainerCreateError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration" | "internal";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return legacyContainerOperationActionability(this.reason);
  }
}

/** `docker start` failed — see {@link legacyPortConflictSuggestion} for the port-already-allocated case. */
export class LegacyContainerStartError extends Data.TaggedError("LegacyContainerStartError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration" | "port_conflict";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return legacyContainerOperationActionability(this.reason);
  }
}

/** Every failure {@link legacyCreateContainer} itself can produce (network creation is separate, see {@link legacyEnsureNetwork}). */
export type LegacyContainerError =
  | LegacyVolumeCreateError
  | LegacyContainerCreateError
  | LegacyContainerStartError;

export interface LegacyContainerOpts {
  /**
   * Go's `Config.ProjectId`, already sanitized (`legacySanitizeProjectId`) by
   * the caller's config-load pipeline — `DockerStart` itself performs no
   * sanitization, it just reads the already-sanitized singleton
   * (`docker.go:375-376`). Merged onto both {@link LEGACY_CLI_PROJECT_LABEL}
   * and {@link LEGACY_COMPOSE_PROJECT_LABEL}, overwriting any value the caller
   * may have already set under those keys in `spec.labels` — exactly like
   * Go's unconditional map assignment.
   */
  readonly projectId: string;
  /**
   * `os.Getenv("BITBUCKET_CLONE_DIR") != ""` — see `legacyIsBitbucketPipeline`
   * (`shared/legacy-bitbucket-pipeline.ts`). Passed in rather than read here so
   * this module stays a pure effect orchestrator with no direct env access,
   * matching `legacyApplyBitbucketStartContainerFilter`'s own boolean-flag
   * shape (`docker-create-args.ts`).
   */
  readonly isBitbucketPipeline: boolean;
  /**
   * `LegacyCliSettings.workdir` — the project's own working directory. Stamped onto every
   * created container as {@link LEGACY_CLI_WORKDIR_LABEL} (see that constant's doc
   * comment) so a later `stop`/{@link legacyRollbackStart} can find this exact directory
   * again from the container's own label, without depending on being invoked from the
   * same cwd/`--workdir` `start` was.
   *
   * NOT used to stage {@link LegacyStartContainerSpec.secretFiles} on host disk anymore —
   * those are delivered straight into the created container via `docker cp` (see
   * {@link legacyCopyStartSecretFilesIntoContainer}), so they never touch host disk at
   * all. This label is still load-bearing for OTHER host-persisted staging under the same
   * `<workdir>/supabase/.temp/start-secrets/<containerName>/` tree that this function
   * itself never writes — e.g. Edge Runtime's own env-file/multiline-env-script
   * staging (`shared/functions/serve.ts`'s `startEdgeRuntimeContainer`),
   * which `legacyCleanupStartSecrets` (`legacy-start-secrets-cleanup.ts`) still reclaims
   * by this same label once that container is torn down.
   */
  readonly workdir: string;
  /**
   * `DockerStart`'s platform-specific `extraHosts` package var
   * (`docker_linux.go`/`docker_darwin.go`/`docker_windows.go`), merged onto
   * EVERY container's `HostConfig.ExtraHosts` (`docker.go:378`) — Linux-only
   * (`["host.docker.internal:host-gateway"]`); empty on Docker Desktop
   * platforms, which already resolve that hostname natively. Merged here
   * (not per-spec) for the same reason the two project-identity labels are:
   * Go applies it identically to every container this orchestrator creates.
   */
  readonly extraHosts: ReadonlyArray<string>;
}

/**
 * Extracts every named-volume source from `binds` (Go's `loader.ParseVolume`
 * classification loop, `docker.go:388-399`): a bind is `source:target[:mode]`
 * (see `docker-create-args.ts`'s `LegacyStartContainerSpec.binds` doc comment
 * and its own worked examples in `docker-create-args.unit.test.ts`), and its
 * source segment is a named volume exactly when
 * {@link legacyIsBindMountSource} says it is NOT a bind-mount path. No dedupe
 * is applied — Go's own `sources` slice doesn't dedupe either, and
 * `Docker.VolumeCreate` is idempotent for a repeated name.
 */
function legacyNamedVolumeSources(binds: ReadonlyArray<string>): ReadonlyArray<string> {
  const sources: Array<string> = [];
  for (const bind of binds) {
    const source = legacyBindMountSpecSource(bind);
    if (source.length > 0 && !legacyIsBindMountSource(source)) {
      sources.push(source);
    }
  }
  return sources;
}

/**
 * Whether `docker`/`podman network create`'s stderr reports the network
 * already existing — the CLI-subprocess equivalent of Go's
 * `errdefs.IsConflict(err)` (`docker.go:70`), which inspects a structured
 * Engine API error instead of stderr text. Docker's real message is `Error
 * response from daemon: network with name <id> already exists`; Podman's is
 * worded differently (`network name <id> already used`), hence the broader
 * pattern rather than matching Docker's exact sentence.
 */
function legacyIsNetworkAlreadyExistsError(stderr: string): boolean {
  return /already exists|already used/iu.test(stderr);
}

/** Go's `portErrorPattern` (`apps/cli-go/internal/utils/docker.go:657`). */
const LEGACY_PORT_BIND_ERROR_PATTERN = /Bind for (.*) failed: port is already allocated/;

function legacyParsePortBindError(stderr: string): string | undefined {
  return LEGACY_PORT_BIND_ERROR_PATTERN.exec(stderr)?.[1];
}

/**
 * A scoped-down port of Go's `suggestDockerStop`
 * (`apps/cli-go/internal/utils/docker.go:667-686`): Go lists every running
 * container, matches the failed host port against each container's own
 * published ports, and reports either `supabase stop --project-id <id>` (the
 * port owner carries the CLI project label) or a bare `docker stop <name>`
 * (it doesn't) — then `docker.go:425-436` appends a further "configure a
 * different port" suggestion on top of that.
 *
 * Reproducing the lookup would mean this pure CLI-orchestration function also
 * lists and inspects every other running container purely to word a hint —
 * disproportionate plumbing for a suggestion string. This reproduces only the
 * detection Go itself starts from (the same regex match) and folds both of
 * Go's suggestion branches into one still-actionable sentence that covers
 * either case without the extra lookup.
 */
function legacyPortConflictSuggestion(hostPort: string, serviceLabel: string): string {
  return (
    `\nTry stopping the project or container already using ${hostPort} ` +
    "(`docker ps` lists what's bound to it, or `supabase stop` for another local Supabase project), " +
    `or configure a different ${serviceLabel} port in supabase/config.toml.`
  );
}

/**
 * Go's `DockerNetworkCreateIfNotExists` (`docker.go:63-77`) via `docker
 * network create --label ... <networkId>`, treating "already exists" as
 * success.
 *
 * Called ONCE, up front, by the caller orchestrating a whole `start` run —
 * NOT per-container the way Go's `DockerStart` calls it on every single
 * invocation. Go's repeated call is a no-op after the first (the network
 * already exists), so this is a pure optimization, not a behavior change: a
 * `start` run's containers are exclusively created by this same code path in
 * one process, never interleaved with an external network deletion, so the
 * network is guaranteed to still exist for every later `legacyCreateContainer`
 * call in the same run.
 *
 * Mirrors Go's own `isUserDefined(mode)` guard (`docker.go:65`,
 * `docker_linux.go:10` and platform siblings) that runs first inside
 * `DockerNetworkCreateIfNotExists` itself: `--network-id default|bridge|host|
 * none` names a built-in Docker network that already exists and cannot be
 * created (`docker network create host` errors with "operation is not
 * permitted on predefined host network"), so this returns immediately without
 * spawning `docker network create` at all for those names, reusing the same
 * `isUserDefinedDockerNetwork` check `shared/functions/functions-docker.ts`
 * already applies for the unrelated `functions deploy`/`functions serve`
 * extension-gateway network.
 */
export function legacyEnsureNetwork(
  spawner: Spawner,
  networkId: string,
  labels: Readonly<Record<string, string>>,
): Effect.Effect<void, LegacyNetworkCreateError> {
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
            new LegacyNetworkCreateError({
              message: `failed to create docker network: ${legacyDescribeContainerCliFailure(cause)}`,
              reason: "runtime",
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new LegacyNetworkCreateError({
              message: "failed to create docker network",
              reason: "runtime",
            }),
        ),
      );
      if (exitCode !== 0 && !legacyIsNetworkAlreadyExistsError(stderr)) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyNetworkCreateError({
            message:
              message.length > 0
                ? `failed to create docker network: ${message}`
                : "failed to create docker network",
            reason: legacyContainerCliReason(message),
          }),
        );
      }
    }),
  );
}

/**
 * Whether `volume create`'s stderr reports the volume already existing —
 * podman's "volume with name <name> already exists: volume already exists",
 * either half. A "...but was not created for the current specification"
 * conflict deliberately does not match, so a real spec conflict still fails.
 */
function legacyIsVolumeAlreadyExistsError(stderr: string): boolean {
  return /volume (?:with name \S+ )?already exists/iu.test(stderr);
}

/**
 * Go's per-source-name `Docker.VolumeCreate` call (`docker.go:407-415`) via
 * `docker volume create --label ...`, treating "already exists" as success the
 * same way {@link legacyEnsureNetwork} does; any other non-zero exit is a
 * real failure.
 *
 * Go's Engine API is idempotent for a repeated name, including against Podman's
 * Docker-compat endpoint; `podman volume create` goes through libpod instead
 * and rejects it, so every `stop`/`start` cycle aborted the bring-up on the
 * volumes `stop` preserves (supabase/cli#6020).
 */
export function legacyEnsureVolume(
  spawner: Spawner,
  name: string,
  labels: Readonly<Record<string, string>>,
): Effect.Effect<void, LegacyVolumeCreateError> {
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
            new LegacyVolumeCreateError({
              message: `failed to create volume: ${legacyDescribeContainerCliFailure(cause)}`,
              reason: "runtime",
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new LegacyVolumeCreateError({
              message: "failed to create volume",
              reason: "runtime",
            }),
        ),
      );
      if (exitCode !== 0 && !legacyIsVolumeAlreadyExistsError(stderr)) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyVolumeCreateError({
            message:
              message.length > 0
                ? `failed to create volume: ${message}`
                : "failed to create volume",
            reason: legacyContainerCliReason(message),
          }),
        );
      }
    }),
  );
}

/** `docker volume inspect` failed to spawn at all (no docker/podman binary). */
export class LegacyVolumeInspectError extends Data.TaggedError("LegacyVolumeInspectError")<{
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
 * Go's pre-create existence check (`_, err := utils.Docker.VolumeInspect(ctx,
 * utils.DbId); utils.NoBackupVolume = errdefs.IsNotFound(err)`,
 * `apps/cli-go/internal/db/start/start.go:165-167`), run BEFORE the volume is
 * created — `docker volume create` is idempotent, so creating first would lose
 * whether the volume already existed. `docker volume inspect <name>` exits 0
 * when the volume exists; a confirmed "no such volume" resolves to `false`,
 * matching Go's `errdefs.IsNotFound`. Any OTHER inspect failure (permission
 * denied, daemon unreachable, …) resolves to `true` instead — Go's
 * `errdefs.IsNotFound(err)` is `false` for any error that isn't specifically a
 * not-found, so Go always defaults to treating the volume as pre-existing
 * (protected from rollback's `volume prune`) unless it can positively confirm
 * otherwise; collapsing every non-zero exit into "doesn't exist" would let an
 * ambiguous inspect failure on a stack with real prior data get pruned by
 * {@link legacyRollbackStart} after any later failure — a data-loss
 * regression Go's own gate doesn't have. Only a spawn failure (neither
 * `docker` nor `podman` on `PATH`) is a real error here.
 *
 * A separate, additional export — NOT called from {@link legacyEnsureVolume}
 * itself, whose existing idempotent-create behavior must not change. The caller
 * orchestrating a `start` run checks this BEFORE creating the volume, to gate the
 * `SetupLocalDatabase`-equivalent pipeline and bucket seeding on "was this a
 * fresh volume", matching Go's exact check-before-create ordering
 * (`internal/db/start/start.go:165-184`).
 */
export function legacyVolumeExists(
  spawner: Spawner,
  name: string,
): Effect.Effect<boolean, LegacyVolumeInspectError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["volume", "inspect", name], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyVolumeInspectError({
              message: `failed to inspect volume: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () => new LegacyVolumeInspectError({ message: "failed to inspect volume" }),
        ),
      );
      if (exitCode === 0) return true;
      return !isVolumeNotFoundMessage(stderr);
    }),
  );
}

/**
 * Whether an EXISTING database volume is accessible (readable AND writable) to the given (slim)
 * Postgres image's own user, via `docker run --rm --entrypoint /usr/bin/sh -v <name>:/probe
 * <image> -c "test -r /probe/PG_VERSION && test -w /probe"` — cheaper than a real bring-up
 * attempt, and runs before any db container is created. Read alone is not enough: Postgres must
 * write `postmaster.pid`/WAL under PGDATA, so a read-only-accessible volume would still
 * crash-loop past this guard. The script exits `0` when accessible, `1` when not (e.g. a
 * docker.io-initialized volume's `700`-mode PGDATA dirs, owned by that image's postgres uid,
 * blocking the slim image's non-root `65532`). Any OTHER exit (spawn failure, or Docker's own
 * `docker run` convention of `125`/`126`/`127` for a daemon/exec-level problem rather than the
 * probed command's own exit) propagates as a genuine docker-run failure instead of being folded
 * into the `1` case.
 */
export function legacyIsVolumeAccessibleToImage(
  spawner: Spawner,
  image: string,
  name: string,
): Effect.Effect<boolean, LegacyContainerCreateError> {
  const fail = (message: string): LegacyContainerCreateError =>
    new LegacyContainerCreateError({ message, reason: "runtime" });
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(
        spawner,
        [
          "run",
          "--rm",
          "--entrypoint",
          "/usr/bin/sh",
          "-v",
          `${name}:/probe`,
          image,
          "-c",
          "test -r /probe/PG_VERSION && test -w /probe",
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      ).pipe(
        Effect.mapError((cause) =>
          fail(
            `failed to probe database volume access: ${legacyDescribeContainerCliFailure(cause)}`,
          ),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError(() => fail("failed to probe database volume access")));
      if (exitCode === 0) return true;
      if (exitCode === 1) return false;
      const message = stderr.trim();
      return yield* Effect.fail(
        fail(
          message.length > 0
            ? `failed to probe database volume access: ${message}`
            : `failed to probe database volume access: exit ${exitCode}`,
        ),
      );
    }),
  );
}

/** `docker container rm -f <id>` (or `docker rm -f`) failed. */
export class LegacyContainerRemoveError extends Data.TaggedError("LegacyContainerRemoveError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return legacyContainerOperationActionability(this.reason);
  }
}

/**
 * Port of Go's `db reset`-only `Docker.ContainerRemove(ctx, DbId,
 * container.RemoveOptions{Force: true})` (`apps/cli-go/internal/db/reset/reset.go:147-149`)
 * via `docker container rm -f <id>`. Unlike most other container lookups in this codebase,
 * Go does NOT tolerate a "not found" response here — a genuine remove failure is a hard
 * `failed to remove container: %w` — so this propagates ANY non-zero exit without the
 * usual "no such container" swallow. `-f` alone (no `-v`) matches Go's `RemoveOptions`,
 * which sets `Force` but not `RemoveVolumes` — the paired named volume is removed
 * separately by {@link legacyRemoveVolume}.
 */
export function legacyRemoveContainer(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<void, LegacyContainerRemoveError> {
  return legacyRunContainerCliExpectSuccess(
    spawner,
    ["container", "rm", "-f", containerId],
    "remove container",
    (message) =>
      new LegacyContainerRemoveError({ message, reason: legacyContainerCliReason(message) }),
  );
}

/** `docker volume rm -f <name>` failed. */
export class LegacyVolumeRemoveError extends Data.TaggedError("LegacyVolumeRemoveError")<{
  readonly message: string;
  readonly reason: "runtime" | "configuration";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return legacyContainerOperationActionability(this.reason);
  }
}

/**
 * Port of Go's `db reset`-only `Docker.VolumeRemove(ctx, DbId, true)`
 * (`apps/cli-go/internal/db/reset/reset.go:150-152`) via `docker volume rm -f <name>`.
 * The `force` argument makes a MISSING volume a no-op (Docker's `DELETE /volumes/{name}`
 * returns 204 even when the volume doesn't exist, once `force` is set — verified against
 * a real Docker daemon), so — unlike {@link legacyRemoveContainer} — no special-casing is
 * needed here: any non-zero exit is a genuine failure.
 */
export function legacyRemoveVolume(
  spawner: Spawner,
  volumeName: string,
): Effect.Effect<void, LegacyVolumeRemoveError> {
  return legacyRunContainerCliExpectSuccess(
    spawner,
    ["volume", "rm", "-f", volumeName],
    "remove volume",
    (message) =>
      new LegacyVolumeRemoveError({ message, reason: legacyContainerCliReason(message) }),
  );
}

function legacyDockerCreateContainer(
  spawner: Spawner,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Effect.Effect<string, LegacyContainerCreateError> {
  return Effect.scoped(
    Effect.gen(function* () {
      // `docker-create-args.ts` emits the key-only `-e KEY` form (never `-e KEY=value`) so
      // secrets never appear in argv/`ps`/`/proc/<pid>/cmdline` (CWE-214/209) — Docker then
      // resolves each key's value from THIS spawned process's own environment. `extendEnv:
      // true` keeps the rest of the parent's env (PATH, the real DOCKER_HOST, …) so the docker
      // CLI invocation itself still behaves correctly; `env` supplies the actual secret values.
      // Matches the same pattern already used for `docker run` (`legacy-docker-run.layer.ts`)
      // and image resolution (`legacy-docker-image-resolve.ts`).
      //
      // Callers must have already stripped `legacyIsDockerClientEnvKey` keys (e.g. a
      // container-facing `DOCKER_HOST`, set by Vector's spec for a tcp/npipe daemon host) from
      // `env` before calling this function — those are emitted inline as `-e KEY=value` by
      // `legacyBuildStartContainerCreateArgs` instead, since `extendEnv: true` merges `env` INTO
      // this spawned process's own environment (per Effect's `ChildProcess` semantics,
      // prioritizing `env`'s values), and that same environment is what the `docker`/`podman`
      // CLI client itself reads `DOCKER_HOST` from to pick which daemon to talk to. Letting a
      // container-facing `DOCKER_HOST` leak in here would hijack this `docker create` call's own
      // daemon target before the container even exists.
      const child = yield* spawnContainerCli(spawner, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
        extendEnv: true,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyContainerCreateError({
              message: `failed to create docker container: ${legacyDescribeContainerCliFailure(cause)}`,
              reason: "runtime",
            }),
        ),
      );
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          legacyCollectText(child.stdout),
          legacyCollectText(child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new LegacyContainerCreateError({
              message: "failed to create docker container",
              reason: "runtime",
            }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyContainerCreateError({
            message:
              message.length > 0
                ? `failed to create docker container: ${message}`
                : "failed to create docker container",
            reason: legacyContainerCliReason(message),
          }),
        );
      }
      return stdout.trim();
    }),
  );
}

function legacyDockerStartContainer(
  spawner: Spawner,
  containerId: string,
  spec: LegacyStartContainerSpec,
): Effect.Effect<void, LegacyContainerStartError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["start", containerId], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyContainerStartError({
              message: `failed to start docker container "${spec.containerName}": ${legacyDescribeContainerCliFailure(cause)}`,
              reason: "runtime",
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new LegacyContainerStartError({
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
        const hostPort = legacyParsePortBindError(trimmed);
        if (hostPort === undefined) {
          return yield* Effect.fail(
            new LegacyContainerStartError({
              message: base,
              reason: legacyContainerCliReason(trimmed),
            }),
          );
        }
        const serviceLabel = spec.networkAliases?.[0] ?? spec.containerName;
        return yield* Effect.fail(
          new LegacyContainerStartError({
            message: `${base}${legacyPortConflictSuggestion(hostPort, serviceLabel)}`,
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
export function legacyDockerCopyArchiveIntoContainer<E>(
  spawner: Spawner,
  archive: Uint8Array | LegacyStartPreStartArchiveSpec["tar"],
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
      }).pipe(Effect.mapError((cause) => fail(legacyDescribeContainerCliFailure(cause))));
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((cause) => fail(legacyDescribeContainerCliFailure(cause))));
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          fail(message.length > 0 ? `exit ${exitCode}: ${message}` : `exit ${exitCode}`),
        );
      }
    }),
  );
}

const legacySecretCopyFailure = (detail: string): LegacyContainerCreateError =>
  new LegacyContainerCreateError({
    message:
      detail.length > 0
        ? `failed to create docker container: failed to copy secret file into container: ${detail}`
        : "failed to create docker container: failed to copy secret file into container",
    reason:
      detail.length > 0 && !legacyIsDockerDaemonUnreachable(detail) ? "configuration" : "runtime",
  });

/**
 * Streams all secret files as one archive after create and before start. `Bun.Archive` exposes no
 * per-entry mode option, so the unit test pins its `0644` default. That mode keeps the files
 * readable by non-root Kong/Postgres processes and matches Go's result. Once copied, the files
 * live in the container filesystem, so normal restarts need no host artifact. This mirrors Go's
 * path-independent Engine API delivery without exposing plaintext through host files or argv.
 */
function legacyCopyStartSecretFilesIntoContainer(
  spawner: Spawner,
  containerId: string,
  secretFiles: ReadonlyArray<LegacyStartSecretFileSpec>,
): Effect.Effect<void, LegacyContainerCreateError> {
  if (secretFiles.length === 0) return Effect.void;

  return Effect.tryPromise({
    try: () =>
      containerArchiveBytes(
        Object.fromEntries(
          secretFiles.map((secretFile) => [secretFile.containerPath, secretFile.content]),
        ),
      ),
    catch: (cause) =>
      new LegacyContainerCreateError({
        message: `failed to create docker container: failed to prepare container secret files: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        reason: "internal",
      }),
  }).pipe(
    Effect.flatMap((archive) =>
      legacyDockerCopyArchiveIntoContainer(
        spawner,
        archive,
        `${containerId}:/`,
        legacySecretCopyFailure,
      ),
    ),
  );
}

/**
 * `docker cp - <containerId>:<containerPath>` with one
 * {@link LegacyStartContainerSpec.preStartArchives} entry's tar bytes on stdin — the ONE `docker
 * cp` form that preserves each archive member's uid/gid inside the container (the host-path form
 * rewrites ownership to root, which a restored Postgres data directory cannot survive; see that
 * field's own doc comment).
 *
 * Sequenced by {@link legacyCreateContainer} between `docker create` and `docker start`, for the
 * same two reasons the secret-file copies are: the container must exist for `docker cp` to have a
 * target, and must not be running yet so its entrypoint never races the copy — which for an
 * archive is not merely a race but the whole point, since the entrypoint's behavior depends on
 * what it finds already unpacked.
 */
function legacyExtractPreStartArchiveIntoContainer(
  spawner: Spawner,
  containerId: string,
  archive: LegacyStartPreStartArchiveSpec,
): Effect.Effect<void, LegacyContainerCreateError> {
  return legacyDockerCopyArchiveIntoContainer(
    spawner,
    archive.tar,
    `${containerId}:${archive.containerPath}`,
    (detail) =>
      new LegacyContainerCreateError({
        message: `failed to create docker container: failed to restore archive into container: ${detail}`,
        reason: "runtime",
      }),
  );
}

/**
 * Port of Go's `DockerStart` (`apps/cli-go/internal/utils/docker.go:363-440`),
 * minus image resolution (already done by `image-prepull.ts`) and network
 * creation (hoisted, see {@link legacyEnsureNetwork}):
 *
 * 1. Merge the two project-identity labels onto `spec.labels`.
 * 2. Provision this container's own named volumes (skipped entirely under
 *    Bitbucket Pipelines, matching Go).
 * 3. Apply the Bitbucket named-volume-bind / security-opt filter
 *    (`legacyApplyBitbucketStartContainerFilter`, already ported).
 * 4. `docker create`.
 * 5. Copy any `secretFiles` into the just-created (not yet started) container
 *    as one stdin tar archive via `docker cp`
 *    (`legacyCopyStartSecretFilesIntoContainer`) — a TS-port-only step with no
 *    Go equivalent, see `docker-create-args.ts`'s `secretFiles` doc comment.
 *    Runs strictly between `docker create` and `docker start`: the container
 *    must already exist for `docker cp` to have a target, and must not be
 *    running yet so its entrypoint never races the copy.
 * 6. Unpack any `preStartArchives` into the same created-but-unstarted
 *    container via `docker cp -` (`legacyExtractPreStartArchiveIntoContainer`)
 *    — also TS-port-only, and for the shadow baseline cache's restored PGDATA
 *    the "not started yet" half of step 5's ordering is the entire point.
 * 7. `docker start`.
 *
 * Resolves to the created container's id/name on success.
 */
export function legacyCreateContainer(
  spawner: Spawner,
  spec: LegacyStartContainerSpec,
  opts: LegacyContainerOpts,
): Effect.Effect<string, LegacyContainerError> {
  return Effect.gen(function* () {
    const labels: Record<string, string> = {
      ...spec.labels,
      [LEGACY_CLI_PROJECT_LABEL]: opts.projectId,
      [LEGACY_COMPOSE_PROJECT_LABEL]: opts.projectId,
    };
    // The workdir label is stamped on the CONTAINER only, not on its named volumes below
    // (`legacyEnsureVolume` is passed `labels`, not `containerLabels`) — a volume's own
    // name already carries the project id, and nothing ever reads a workdir label back off a
    // volume the way `legacyListContainerIdsAndNames` does for containers.
    const containerLabels: Record<string, string> = {
      ...labels,
      [LEGACY_CLI_WORKDIR_LABEL]: opts.workdir,
    };
    const labeledSpec: LegacyStartContainerSpec = {
      ...spec,
      labels: containerLabels,
      extraHosts: [...(spec.extraHosts ?? []), ...opts.extraHosts],
    };

    if (!opts.isBitbucketPipeline) {
      for (const name of legacyNamedVolumeSources(labeledSpec.binds)) {
        yield* legacyEnsureVolume(spawner, name, labels);
      }
    }

    const finalSpec = legacyApplyBitbucketStartContainerFilter(
      labeledSpec,
      opts.isBitbucketPipeline,
    );

    const createArgs = legacyBuildStartContainerCreateArgs(finalSpec);
    // `legacyIsDockerClientEnvKey` keys (e.g. Vector's container-facing `DOCKER_HOST`) are
    // already emitted inline as `-e KEY=value` by `legacyBuildStartContainerCreateArgs` above —
    // see `legacyDockerCreateContainer`'s doc comment for why they must not also reach the
    // spawned `docker create` process's own environment.
    const createProcessEnv = Object.fromEntries(
      Object.entries(finalSpec.env).filter(([key]) => !legacyIsDockerClientEnvKey(key)),
    );
    const containerId = yield* legacyDockerCreateContainer(spawner, createArgs, createProcessEnv);
    yield* legacyCopyStartSecretFilesIntoContainer(
      spawner,
      containerId,
      finalSpec.secretFiles ?? [],
    );
    // Sequentially, not concurrently like the secret files: two archives could legitimately
    // overlap in the container's filesystem, so the spec's own order has to be the applied order.
    //
    // A failed extraction removes the just-created container (best-effort, `-v` so an anonymous
    // volume goes with it) before failing. The secret-file/`docker start` steps deliberately do
    // NOT do this — their established post-create failure window leaves cleanup to the caller's
    // finalizer (see `legacyCreateShadowDatabase`'s doc comment, `shadow-database.ts`) — but
    // `preStartArchives`' one producer (the shadow baseline cache's warm restore) recovers from
    // this exact failure by provisioning a replacement, which must not accumulate an orphaned
    // created container per recovery.
    yield* Effect.forEach(
      finalSpec.preStartArchives ?? [],
      (archive) => legacyExtractPreStartArchiveIntoContainer(spawner, containerId, archive),
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
    yield* legacyDockerStartContainer(spawner, containerId, finalSpec);
    return containerId;
  });
}
