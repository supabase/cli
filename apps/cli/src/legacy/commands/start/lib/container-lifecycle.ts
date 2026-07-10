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
 * of this per-container function — see {@link legacyEnsureStartNetwork}'s doc
 * comment for why it is hoisted to run once instead of once per container.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  legacyDescribeContainerCliFailure,
  spawnContainerCli,
} from "../../../shared/legacy-container-cli.ts";
import { legacyIsBindMountSource } from "../../../shared/legacy-docker-bind-classify.ts";
import { LEGACY_CLI_PROJECT_LABEL } from "../../../shared/legacy-docker-ids.ts";
import {
  buildLegacyStartContainerCreateArgs,
  legacyApplyBitbucketStartContainerFilter,
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
const LEGACY_COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** `docker network create --label ...`/`docker volume create --label ...` failed. */
export class LegacyStartNetworkCreateError extends Data.TaggedError(
  "LegacyStartNetworkCreateError",
)<{
  readonly message: string;
}> {}

export class LegacyStartVolumeCreateError extends Data.TaggedError("LegacyStartVolumeCreateError")<{
  readonly message: string;
}> {}

/** `docker create` failed. */
export class LegacyStartContainerCreateError extends Data.TaggedError(
  "LegacyStartContainerCreateError",
)<{
  readonly message: string;
}> {}

/** `docker start` failed — see {@link legacyPortConflictSuggestion} for the port-already-allocated case. */
export class LegacyStartContainerStartError extends Data.TaggedError(
  "LegacyStartContainerStartError",
)<{
  readonly message: string;
}> {}

/** Every failure {@link legacyStartContainer} itself can produce (network creation is separate, see {@link legacyEnsureStartNetwork}). */
export type LegacyStartContainerError =
  | LegacyStartVolumeCreateError
  | LegacyStartContainerCreateError
  | LegacyStartContainerStartError;

export interface LegacyStartContainerOpts {
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
   * `LegacyCliConfig.workdir` — the project's own working directory. Used
   * exclusively to root {@link legacyStageStartSecretFiles}'s deterministic,
   * persistent host directory (`<workdir>/supabase/.temp/start-secrets/<containerName>/`)
   * so staged secret files survive a host/Docker-daemon restart — see that
   * function's doc comment for why.
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

function collectText(stream: Stream.Stream<Uint8Array, unknown>) {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    () => "",
    (text, chunk) => text + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((text) => text + decoder.decode()));
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
    const source = bind.split(":")[0] ?? "";
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
 * network is guaranteed to still exist for every later `legacyStartContainer`
 * call in the same run.
 */
export function legacyEnsureStartNetwork(
  spawner: Spawner,
  networkId: string,
  labels: Readonly<Record<string, string>>,
): Effect.Effect<void, LegacyStartNetworkCreateError> {
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
            new LegacyStartNetworkCreateError({
              message: `failed to create docker network: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () => new LegacyStartNetworkCreateError({ message: "failed to create docker network" }),
        ),
      );
      if (exitCode !== 0 && !legacyIsNetworkAlreadyExistsError(stderr)) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyStartNetworkCreateError({
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
export function legacyEnsureStartVolume(
  spawner: Spawner,
  name: string,
  labels: Readonly<Record<string, string>>,
): Effect.Effect<void, LegacyStartVolumeCreateError> {
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
            new LegacyStartVolumeCreateError({
              message: `failed to create volume: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () => new LegacyStartVolumeCreateError({ message: "failed to create volume" }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyStartVolumeCreateError({
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
export class LegacyStartVolumeInspectError extends Data.TaggedError(
  "LegacyStartVolumeInspectError",
)<{
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
 * A separate, additional export — NOT called from {@link legacyEnsureStartVolume}
 * itself, whose existing idempotent-create behavior must not change. The caller
 * orchestrating a `start` run checks this BEFORE creating the volume, to gate the
 * `SetupLocalDatabase`-equivalent pipeline and bucket seeding on "was this a
 * fresh volume", matching Go's exact check-before-create ordering
 * (`internal/db/start/start.go:165-184`).
 */
export function legacyStartVolumeExists(
  spawner: Spawner,
  name: string,
): Effect.Effect<boolean, LegacyStartVolumeInspectError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["volume", "inspect", name], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyStartVolumeInspectError({
              message: `failed to inspect volume: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () => new LegacyStartVolumeInspectError({ message: "failed to inspect volume" }),
        ),
      );
      if (exitCode === 0) return true;
      return !isVolumeNotFoundMessage(stderr);
    }),
  );
}

function legacyDockerCreateContainer(
  spawner: Spawner,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Effect.Effect<string, LegacyStartContainerCreateError> {
  return Effect.scoped(
    Effect.gen(function* () {
      // `docker-create-args.ts` emits the key-only `-e KEY` form (never `-e KEY=value`) so
      // secrets never appear in argv/`ps`/`/proc/<pid>/cmdline` (CWE-214/209) — Docker then
      // resolves each key's value from THIS spawned process's own environment. `extendEnv:
      // true` keeps the rest of the parent's env (PATH, DOCKER_HOST, …) so the docker CLI
      // invocation itself still behaves correctly; `env` supplies the actual secret values.
      // Matches the same pattern already used for `docker run` (`legacy-docker-run.layer.ts`)
      // and image resolution (`legacy-docker-image-resolve.ts`).
      const child = yield* spawnContainerCli(spawner, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
        extendEnv: true,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyStartContainerCreateError({
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
          () =>
            new LegacyStartContainerCreateError({ message: "failed to create docker container" }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyStartContainerCreateError({
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
): Effect.Effect<void, LegacyStartContainerStartError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["start", containerId], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyStartContainerStartError({
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
            new LegacyStartContainerStartError({
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
          return yield* Effect.fail(new LegacyStartContainerStartError({ message: base }));
        }
        const serviceLabel = spec.networkAliases?.[0] ?? spec.containerName;
        return yield* Effect.fail(
          new LegacyStartContainerStartError({
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
 * `0700` and one file per entry at mode `0600` — both owner-only, so no other
 * local user on the host can even list the staged file names/count (let
 * alone read their contents) while they exist — then returns the
 * `<hostPath>:<containerPath>:ro`
 * bind for each. Mirrors this same session's `-e KEY`-only env fix
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
 * `legacyStartContainer` never resolves this for a container while an
 * earlier instance of that same container might still be reading from it —
 * see that function's doc comment.
 */
function legacyStageStartSecretFiles(
  secretFiles: ReadonlyArray<LegacyStartSecretFileSpec>,
  containerName: string,
  workdir: string,
): Effect.Effect<
  { readonly binds: ReadonlyArray<string>; readonly cleanup: () => Promise<void> },
  LegacyStartContainerCreateError
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
            await writeFile(hostPath, secretFile.content, { mode: 0o600 });
            return `${hostPath}:${secretFile.containerPath}:ro`;
          }),
        );
        return { binds, cleanup: () => rm(dir, { recursive: true, force: true }) };
      } catch (cause) {
        await rm(dir, { recursive: true, force: true });
        throw cause;
      }
    },
    catch: (cause) =>
      new LegacyStartContainerCreateError({
        message: `failed to create docker container: failed to stage container secret files: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  });
}

/**
 * Port of Go's `DockerStart` (`apps/cli-go/internal/utils/docker.go:363-440`),
 * minus image resolution (already done by `image-prepull.ts`) and network
 * creation (hoisted, see {@link legacyEnsureStartNetwork}):
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
 *    comment. Only cleaned up (best-effort, `Effect.tapError`) when `docker
 *    create`/`docker start` itself FAILS and the container never successfully
 *    starts — nothing is depending on the files at that point.
 *
 * Resolves to the created container's id/name on success.
 */
export function legacyStartContainer(
  spawner: Spawner,
  spec: LegacyStartContainerSpec,
  opts: LegacyStartContainerOpts,
): Effect.Effect<string, LegacyStartContainerError> {
  return Effect.gen(function* () {
    const labels: Record<string, string> = {
      ...spec.labels,
      [LEGACY_CLI_PROJECT_LABEL]: opts.projectId,
      [LEGACY_COMPOSE_PROJECT_LABEL]: opts.projectId,
    };
    const labeledSpec: LegacyStartContainerSpec = {
      ...spec,
      labels,
      extraHosts: [...(spec.extraHosts ?? []), ...opts.extraHosts],
    };

    if (!opts.isBitbucketPipeline) {
      for (const name of legacyNamedVolumeSources(labeledSpec.binds)) {
        yield* legacyEnsureStartVolume(spawner, name, labels);
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
      const createArgs = buildLegacyStartContainerCreateArgs(specWithSecretBinds);
      const containerId = yield* legacyDockerCreateContainer(
        spawner,
        createArgs,
        specWithSecretBinds.env,
      );
      yield* legacyDockerStartContainer(spawner, containerId, specWithSecretBinds);
      return containerId;
    }).pipe(
      Effect.tapError(() =>
        Effect.promise(cleanupSecretFiles).pipe(Effect.catchCause(() => Effect.void)),
      ),
    );
  });
}
