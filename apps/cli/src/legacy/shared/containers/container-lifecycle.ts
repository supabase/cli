/**
 * Port of Go's `DockerStart` (`apps/cli-go/internal/utils/docker.go:363-440`):
 * given a fully-resolved {@link LegacyStartContainerSpec} (image already
 * resolved by `image-prepull.ts` — see its doc comment), sets the two
 * project-identity labels, provisions this container's own named volumes,
 * stages any `secretFiles` onto the host (see {@link legacyStageStartSecretFiles}),
 * builds the `docker create` argv (`docker-create-args.ts`), and spawns
 * `docker create` + `docker start`.
 *
 * Network creation (`DockerNetworkCreateIfNotExists`) is deliberately NOT part
 * of this per-container function — see {@link legacyEnsureNetwork}'s doc
 * comment for why it is hoisted to run once instead of once per container.
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  collectText,
  legacyDescribeContainerCliFailure,
  runContainerCliExpectSuccess,
  spawnContainerCli,
} from "../legacy-container-cli.ts";
import {
  legacyBindMountSpecSource,
  legacyIsBindMountSource,
} from "../legacy-docker-bind-classify.ts";
import { LEGACY_CLI_PROJECT_LABEL, LEGACY_CLI_WORKDIR_LABEL } from "../legacy-docker-ids.ts";
import { isUserDefinedDockerNetwork } from "../../../shared/functions/deploy.ts";
import {
  legacyBuildStartContainerCreateArgs,
  legacyApplyBitbucketStartContainerFilter,
  legacyIsDockerClientEnvKey,
  type LegacyStartContainerSpec,
} from "./docker-create-args.ts";

/** Structural element type of {@link LegacyStartContainerSpec.secretFiles} — not exported from `docker-create-args.ts`, so referenced positionally here. */
type LegacyStartSecretFileSpec = NonNullable<LegacyStartContainerSpec["secretFiles"]>[number];

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
 * `shared/functions/deploy.ts` (`dockerComposeProjectLabel`, for the unrelated
 * `functions deploy` Docker Desktop extension gateway) but is neither exported
 * nor in the same Docker-usage domain as `start` — not hoisted from there.
 */
export const LEGACY_COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** `docker network create --label ...`/`docker volume create --label ...` failed. */
export class LegacyNetworkCreateError extends Data.TaggedError("LegacyNetworkCreateError")<{
  readonly message: string;
}> {}

export class LegacyVolumeCreateError extends Data.TaggedError("LegacyVolumeCreateError")<{
  readonly message: string;
}> {}

/** `docker create` failed. */
export class LegacyContainerCreateError extends Data.TaggedError("LegacyContainerCreateError")<{
  readonly message: string;
}> {}

/** `docker start` failed — see {@link legacyPortConflictSuggestion} for the port-already-allocated case. */
export class LegacyContainerStartError extends Data.TaggedError("LegacyContainerStartError")<{
  readonly message: string;
}> {}

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
   * `LegacyCliConfig.workdir` — the project's own working directory. Roots
   * {@link legacyStageStartSecretFiles}'s deterministic, persistent host directory
   * (`<workdir>/supabase/.temp/start-secrets/<containerName>/`) so staged secret files
   * survive a host/Docker-daemon restart — see that function's doc comment for why.
   *
   * Also stamped onto every created container as {@link LEGACY_CLI_WORKDIR_LABEL} (see
   * that constant's doc comment) so a later `stop`/{@link legacyRollbackStart} can find
   * this exact directory again from the container's own label, without depending on
   * being invoked from the same cwd/`--workdir` `start` was.
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
 * `isUserDefinedDockerNetwork` check `shared/functions/deploy.ts` already
 * applies for the unrelated `functions deploy` extension-gateway network.
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
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () => new LegacyNetworkCreateError({ message: "failed to create docker network" }),
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
          }),
        );
      }
    }),
  );
}

/**
 * Go's per-source-name `Docker.VolumeCreate` call (`docker.go:407-415`) via
 * `docker volume create --label ...`. Unlike network creation, Go applies no
 * "already exists" tolerance here — `VolumeCreate` is already idempotent for a
 * repeated name with matching options, so any non-zero exit is a real failure.
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
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(() => new LegacyVolumeCreateError({ message: "failed to create volume" })),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyVolumeCreateError({
            message:
              message.length > 0
                ? `failed to create volume: ${message}`
                : "failed to create volume",
          }),
        );
      }
    }),
  );
}

/** `docker volume inspect` failed to spawn at all (no docker/podman binary). */
export class LegacyVolumeInspectError extends Data.TaggedError("LegacyVolumeInspectError")<{
  readonly message: string;
}> {}

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
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
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

/** `docker container rm -f <id>` (or `docker rm -f`) failed. */
export class LegacyContainerRemoveError extends Data.TaggedError("LegacyContainerRemoveError")<{
  readonly message: string;
}> {}

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
  return runContainerCliExpectSuccess(
    spawner,
    ["container", "rm", "-f", containerId],
    "remove container",
    (message) => new LegacyContainerRemoveError({ message }),
  );
}

/** `docker volume rm -f <name>` failed. */
export class LegacyVolumeRemoveError extends Data.TaggedError("LegacyVolumeRemoveError")<{
  readonly message: string;
}> {}

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
  return runContainerCliExpectSuccess(
    spawner,
    ["volume", "rm", "-f", volumeName],
    "remove volume",
    (message) => new LegacyVolumeRemoveError({ message }),
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
          () => new LegacyContainerCreateError({ message: "failed to create docker container" }),
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
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new LegacyContainerStartError({
              message: `failed to start docker container "${spec.containerName}"`,
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
          return yield* Effect.fail(new LegacyContainerStartError({ message: base }));
        }
        const serviceLabel = spec.networkAliases?.[0] ?? spec.containerName;
        return yield* Effect.fail(
          new LegacyContainerStartError({
            message: `${base}${legacyPortConflictSuggestion(hostPort, serviceLabel)}`,
          }),
        );
      }
    }),
  );
}

/**
 * Writes each {@link LegacyStartContainerSpec.secretFiles} entry's `content`
 * to a HOST directory scoped to this container, at the DETERMINISTIC path
 * `<workdir>/supabase/.temp/start-secrets/<containerName>/` (matching this
 * codebase's existing `<workdir>/supabase/.temp/` convention for CLI-owned
 * scratch state — see `legacy-linked-project-cache.layer.ts`), directory mode
 * `0700` and one file per entry force-`chmod`'d to mode `0644` after writing
 * (a creation-time `writeFile({ mode })` is only ever the argument to the
 * underlying `open()`/`creat()` syscall, which the kernel ANDs with `~umask`
 * — under a restrictive shell umask like `077`/`027` the file would otherwise
 * land at `0600`, unlike `chmod`, which sets the mode unconditionally) — the
 * directory stays
 * owner-only (the kernel checks execute/search permission on this ancestor
 * directory before it ever checks a file's own mode, so no other local user
 * on the host can list the staged file names/count or read their contents
 * while they exist), but each file is world-readable: it is bind-mounted
 * `:ro` into a container that reads it as a NON-ROOT in-container user
 * (Kong's image runs as uid 100 `kong`; Postgres's entrypoint drops root and
 * reads `pgsodium_root.key` as the `postgres` user), and a Linux/Podman bind
 * mount preserves the host file's uid/mode verbatim inside the container, so
 * an arbitrary host-invoking uid at `0600` would get `EACCES` there — Go's
 * own equivalent (heredoc'd directly into the container by a root-authored
 * entrypoint script) already lands at world-readable `0644`, matching this
 * exactly — then returns the `<hostPath>:<containerPath>:ro,Z` bind for each
 * (`Z`: private SELinux relabel — see the inline comment at the bind).
 * Mirrors this same session's `-e KEY`-only env fix
 * (`legacyDockerCreateContainer`'s doc comment) for entrypoint/`Cmd`-bound
 * secret content instead of env values: the file's HOST path is the only
 * thing that ever reaches `docker create`'s argv, never the secret `content`
 * itself (CWE-214/522).
 *
 * Deliberately NOT an ephemeral `os.tmpdir()` directory (`fs.mkdtemp`, this
 * function's original implementation): every container that uses this
 * mechanism (Kong, Postgres, Supavisor) runs with `restartPolicy:
 * "unless-stopped"`, so dockerd re-attaches its bind mounts on its own after
 * a host/daemon restart — by which point `supabase start`'s own process (and
 * any `os.tmpdir()` directory it made, which is frequently tmpfs on Linux and
 * wiped on reboot regardless) is long gone. Re-attaching a bind mount whose
 * host source no longer exists either fails outright or (with the legacy `-v
 * host:container` syntax) silently recreates an empty directory there —
 * either way silently dropping the secret content (e.g. Postgres's
 * `pgsodium_root.key`) until the user manually reruns `stop` + `start`. A
 * path rooted in the project's own working directory survives the restart,
 * exactly like Go's own heredoc'd-into-`Entrypoint`/`Cmd` approach does (via
 * dockerd's own persisted container metadata) — without reintroducing the
 * argv-exposure problem that approach has.
 *
 * Self-healing: any pre-existing directory at this path is removed FIRST,
 * before writing fresh files, on every call — so a config change that
 * shrinks or removes `secretFiles` between `start` invocations never leaves a
 * stale file behind, and no orphaned directories accumulate across restarts.
 * `legacyCreateContainer` never resolves this for a container while an
 * earlier instance of that same container might still be reading from it —
 * see that function's doc comment.
 */
function legacyStageStartSecretFiles(
  secretFiles: ReadonlyArray<LegacyStartSecretFileSpec>,
  containerName: string,
  workdir: string,
): Effect.Effect<
  { readonly binds: ReadonlyArray<string>; readonly cleanup: () => Promise<void> },
  LegacyContainerCreateError
> {
  const dir = join(workdir, "supabase", ".temp", "start-secrets", containerName);
  return Effect.tryPromise({
    try: async () => {
      await rm(dir, { recursive: true, force: true });
      if (secretFiles.length === 0) {
        return { binds: [], cleanup: () => Promise.resolve() };
      }
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const binds = await Promise.all(
          secretFiles.map(async (secretFile, index) => {
            const hostPath = join(dir, `secret-${index}`);
            await writeFile(hostPath, secretFile.content, { mode: 0o644 });
            // `writeFile`'s `mode` is only a creation-time hint the kernel ANDs with the
            // process umask — force the final mode explicitly so a restrictive umask (e.g.
            // `077`/`027`) can't silently narrow this to `0600` and break the non-root
            // in-container reader (see this function's doc comment).
            await chmod(hostPath, 0o644);
            // `Z`: SELinux-enforcing hosts (e.g. Fedora + rootless Podman) relabel this
            // CLI-generated file so the confined container can read it (supabase/cli#5989).
            // Private label, not shared `z` — each staged dir is 1:1 with one container,
            // and no sibling container has any business reading these secrets. No-op
            // elsewhere; Docker/Podman ignore ENOTSUP from non-labelable filesystems.
            return `${hostPath}:${secretFile.containerPath}:ro,Z`;
          }),
        );
        return { binds, cleanup: () => rm(dir, { recursive: true, force: true }) };
      } catch (cause) {
        await rm(dir, { recursive: true, force: true });
        throw cause;
      }
    },
    catch: (cause) =>
      new LegacyContainerCreateError({
        message: `failed to create docker container: failed to stage container secret files: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  });
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
 * 4. Stage any `secretFiles` onto the host and append their bind mounts
 *    (`legacyStageStartSecretFiles`) — a TS-port-only step with no Go
 *    equivalent, see `docker-create-args.ts`'s `secretFiles` doc comment.
 * 5. `docker create` then `docker start`. The staged secret files are left in
 *    place on success — they must persist for the container's whole
 *    lifetime so a `restartPolicy: "unless-stopped"` restart (dockerd
 *    re-attaching bind mounts after a host reboot, long after this process
 *    has exited) can still read them; see `legacyStageStartSecretFiles`'s doc
 *    comment. Only cleaned up (best-effort, `Effect.onError` — not
 *    `Effect.tapError`, which is built on `Cause.findError` and never sees a
 *    pure SIGINT/SIGTERM interrupt, the same gap already fixed for the
 *    top-level bring-up rollback in `start.handler.ts`) when `docker
 *    create`/`docker start` itself FAILS, is interrupted, or the container
 *    never successfully starts — nothing is depending on the files at that
 *    point, and this fires regardless of whether a container was ever
 *    created, so it doesn't depend on `docker ps`-based discovery the way
 *    `legacyCleanupStartSecrets` does. Once the container is actually torn
 *    down (a failed-start rollback, or a later `stop`),
 *    `legacyCleanupStartSecrets` (`legacy-start-secrets-cleanup.ts`) reclaims
 *    the staged directory then instead.
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

    const { binds: secretBinds, cleanup: cleanupSecretFiles } = yield* legacyStageStartSecretFiles(
      finalSpec.secretFiles ?? [],
      finalSpec.containerName,
      opts.workdir,
    );
    const specWithSecretBinds: LegacyStartContainerSpec =
      secretBinds.length === 0
        ? finalSpec
        : { ...finalSpec, binds: [...finalSpec.binds, ...secretBinds] };

    return yield* Effect.gen(function* () {
      const createArgs = legacyBuildStartContainerCreateArgs(specWithSecretBinds);
      // `legacyIsDockerClientEnvKey` keys (e.g. Vector's container-facing `DOCKER_HOST`) are
      // already emitted inline as `-e KEY=value` by `legacyBuildStartContainerCreateArgs` above —
      // see `legacyDockerCreateContainer`'s doc comment for why they must not also reach the
      // spawned `docker create` process's own environment.
      const createProcessEnv = Object.fromEntries(
        Object.entries(specWithSecretBinds.env).filter(([key]) => !legacyIsDockerClientEnvKey(key)),
      );
      const containerId = yield* legacyDockerCreateContainer(spawner, createArgs, createProcessEnv);
      yield* legacyDockerStartContainer(spawner, containerId, specWithSecretBinds);
      return containerId;
    }).pipe(
      Effect.onError(() =>
        Effect.promise(cleanupSecretFiles).pipe(Effect.catchCause(() => Effect.void)),
      ),
    );
  });
}
