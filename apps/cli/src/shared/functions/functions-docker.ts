// Docker orchestration primitives shared by `deploy.ts` and `download.ts`
// (the `functions` command family root, `src/shared/functions/`) — plus
// `serve.ts` (same family) and `legacy/commands/start/lib/container-lifecycle.ts`
// (a different family, reaching in for the generic `isUserDefinedDockerNetwork`
// predicate), both of which already imported these primitives from `deploy.ts`
// before this file existed.
import { resolve } from "node:path";
import { Effect, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { spawnContainerCli } from "../../legacy/shared/legacy-container-cli.ts";
import { legacyMakeDockerImageResolver } from "../../legacy/shared/legacy-docker-image-resolve.ts";

const INVALID_PROJECT_ID = /[^a-zA-Z0-9_.-]+/g;
const MAX_PROJECT_ID_LENGTH = 40;
const DENO1_EDGE_RUNTIME_VERSION = "1.68.4";

export function toSlash(pathname: string) {
  return pathname.replaceAll("\\", "/");
}

export function normalizeProjectId(source: string) {
  const sanitized = source.replaceAll(INVALID_PROJECT_ID, "_").replace(/^[_.-]+/, "");
  return sanitized.length > MAX_PROJECT_ID_LENGTH
    ? sanitized.slice(0, MAX_PROJECT_ID_LENGTH)
    : sanitized;
}

export function localDockerId(name: string, projectId: string) {
  return `supabase_${name}_${normalizeProjectId(projectId)}`;
}

/**
 * Go: `DockerStart`'s network selection (`internal/utils/docker.go:379-383`)
 * combined with root's `viper.BindPFlags`/`AutomaticEnv` for the persistent
 * `--network-id` flag (`cmd/root.go:316-334`). viper's `find()` resolves a
 * `Changed` pflag *before* it ever consults a bound env var (`viper.go`'s
 * flag-override branch precedes its env-override branch) — so an explicit
 * `--network-id=` (empty, but still marks the flag `Changed`) makes
 * `viper.GetString("network-id")` return `""` and stop there, WITHOUT
 * falling through to `SUPABASE_NETWORK_ID`; only THEN does the consuming
 * `len(networkId) > 0` check fall through, straight to the generated
 * default. An explicit-but-empty *env* value, by contrast, genuinely means
 * unset (viper never enables `AllowEmptyEnv`) and falls through to the
 * default the normal way. Net effect: `explicit === undefined` (flag never
 * touched) is the ONLY case that consults `envOverride` — `explicit === ""`
 * (flag explicitly cleared) skips straight to the generated default, same
 * as a non-empty `explicit` skips it by using the flag's own value. Callers
 * MUST pass a flag reader that preserves this 3-way distinction — see
 * `explicitStringFlag`.
 * `envOverride` is `undefined` in `next` (no Go-viper env-binding claim
 * there) — see `resolveDockerNetworkMode`'s callers.
 */
export function resolveDockerNetworkMode(input: {
  readonly explicit: string | undefined;
  readonly envOverride: string | undefined;
  readonly projectId: string;
}): string {
  if (input.explicit !== undefined) {
    return input.explicit.length > 0 ? input.explicit : localDockerId("network", input.projectId);
  }
  if (input.envOverride !== undefined && input.envOverride.length > 0) {
    return input.envOverride;
  }
  return localDockerId("network", input.projectId);
}

const dockerCliProjectLabel = "com.supabase.cli.project";
const dockerComposeProjectLabel = "com.docker.compose.project";

export function dockerProjectLabels(projectId: string) {
  return {
    [dockerCliProjectLabel]: projectId,
    [dockerComposeProjectLabel]: projectId,
  };
}

export function toDockerPath(hostPath: string) {
  const normalized = toSlash(resolve(hostPath));
  return normalized.replace(/^[A-Za-z]:/, "");
}

export interface FunctionsDockerRunSpec {
  /** Already registry/pull-resolved image reference. */
  readonly image: string;
  /** Go's `Config.ProjectId` — the label value (`docker.go:374-376`). */
  readonly projectId: string;
  readonly networkMode: string;
  readonly binds: ReadonlyArray<string>;
  /** `KEY=VALUE` entries, each emitted as `-e KEY=VALUE`. */
  readonly env?: ReadonlyArray<string>;
  /** argv after the image, e.g. `["bundle", "--entrypoint", …]`. */
  readonly containerArgs: ReadonlyArray<string>;
  readonly platform?: NodeJS.Platform;
}

/**
 * Assembles the one-shot `docker run` invocation shared by `deploy.ts`'s
 * bundler and `download.ts`'s unbundler containers: binds, network, the
 * linux `host.docker.internal` workaround, env, and Go's unconditional
 * `com.supabase.cli.project`/`com.docker.compose.project` labels
 * (`DockerStart`, `internal/utils/docker.go:349-386`) — previously applied
 * only to the network/volume these containers depend on
 * (`ensureDockerNetwork`/`ensureDockerNamedVolume` above), never to the
 * one-shot containers themselves, so label-based cleanup/inspection couldn't
 * associate an orphaned container with the project.
 */
export function buildFunctionsDockerRunArgs(spec: FunctionsDockerRunSpec): Array<string> {
  const command = ["run", "--rm", ...spec.binds.flatMap((bind) => ["-v", bind])];
  command.push("--network", spec.networkMode);
  if ((spec.platform ?? process.platform) === "linux") {
    command.push("--add-host", "host.docker.internal:host-gateway");
  }
  for (const env of spec.env ?? []) {
    command.push("-e", env);
  }
  const labels = dockerProjectLabels(spec.projectId);
  command.push(
    "--label",
    `${dockerCliProjectLabel}=${labels[dockerCliProjectLabel]}`,
    "--label",
    `${dockerComposeProjectLabel}=${labels[dockerComposeProjectLabel]}`,
  );
  command.push(spec.image, ...spec.containerArgs);
  return command;
}

// Decodes a byte stream to text, both accumulating the full text (returned,
// for callers that need to post-process it, e.g. scanning stderr for
// "invalid eszip v2") AND tee-ing each decoded chunk to `onChunk` as it
// arrives — Go's `DockerStreamLogs`/`DockerRunOnceWithConfig` copy a
// container's log stream live while it runs, rather than buffering the whole
// thing until exit.
function collectByteStream(
  stream: Stream.Stream<Uint8Array, unknown>,
  onChunk?: (chunk: string) => Effect.Effect<void>,
): Effect.Effect<string, unknown> {
  return Effect.suspend(() => {
    const decoder = new TextDecoder();
    let text = "";
    const append = (chunk: string) => {
      text += chunk;
      return chunk.length > 0 && onChunk !== undefined ? onChunk(chunk) : Effect.void;
    };
    return Stream.runForEach(stream, (bytes) =>
      append(decoder.decode(bytes, { stream: true })),
    ).pipe(
      Effect.flatMap(() => append(decoder.decode())),
      Effect.map(() => text),
    );
  });
}

// Runs a container CLI command and collects its output. Every caller runs
// `docker`, so the spawn goes through `spawnContainerCli` to fall back to
// `podman` on Docker-less hosts. `command` is retained for the extendEnv
// default and the `functions serve` dependency-injection seam.
export const runChildProcess = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  opts: {
    readonly stdout?: "pipe" | "ignore";
    readonly stderr?: "pipe" | "ignore";
    readonly env?: Readonly<Record<string, string>>;
    readonly extendEnv?: boolean;
    /** Tees each decoded stdout chunk as it arrives, live — see {@link collectByteStream}. */
    readonly onStdout?: (chunk: string) => Effect.Effect<void>;
    /** Tees each decoded stderr chunk as it arrives, live — see {@link collectByteStream}. */
    readonly onStderr?: (chunk: string) => Effect.Effect<void>;
  } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawnContainerCli(spawner, [...args], {
    stdin: "ignore",
    stdout: opts.stdout ?? "pipe",
    stderr: opts.stderr ?? "pipe",
    env: opts.env,
    extendEnv: opts.extendEnv ?? command === "docker",
  });

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      opts.stdout === "ignore"
        ? Effect.succeed("")
        : collectByteStream(child.stdout, opts.onStdout),
      opts.stderr === "ignore"
        ? Effect.succeed("")
        : collectByteStream(child.stderr, opts.onStderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { exitCode, stdout, stderr };
});

// Go: `container.NetworkMode.IsContainer()` (`docker/api/types/container/hostconfig.go:152-155`,
// via the unexported `containerID` helper, same file:493-499) — `--network container:<name|id>`
// (Docker's syntax for attaching to another container's network stack) is recognized by a bare
// `"container:"` prefix before the first `:`, regardless of what (if anything) follows it.
function isContainerDockerNetworkMode(networkMode: string) {
  const separatorIndex = networkMode.indexOf(":");
  return separatorIndex !== -1 && networkMode.slice(0, separatorIndex) === "container";
}

// Go: `container.NetworkMode.IsUserDefined()` (`docker/api/types/container/hostconfig_unix.go:23-25`)
// — `!IsDefault() && !IsBridge() && !IsHost() && !IsNone() && !IsContainer()`. Omitting the
// `IsContainer()` exclusion would make `DockerNetworkCreateIfNotExists`
// (`internal/utils/docker.go:63`) run `docker network inspect`/`create` against a
// `container:<name|id>` mode, which isn't a network name at all — Go passes that mode straight
// through to the container's `NetworkMode` without ever touching the network subsystem.
export function isUserDefinedDockerNetwork(networkMode: string) {
  return (
    networkMode.length > 0 &&
    networkMode !== "default" &&
    networkMode !== "bridge" &&
    networkMode !== "host" &&
    networkMode !== "none" &&
    !isContainerDockerNetworkMode(networkMode)
  );
}

export const ensureDockerNetwork = Effect.fnUntraced(function* (
  networkMode: string,
  projectId: string,
) {
  if (!isUserDefinedDockerNetwork(networkMode)) {
    return;
  }

  const inspect = yield* runChildProcess("docker", ["network", "inspect", networkMode], {
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));
  if (inspect.exitCode === 0) {
    return;
  }

  const labels = dockerProjectLabels(projectId);
  const create = yield* runChildProcess(
    "docker",
    [
      "network",
      "create",
      "--label",
      `${dockerCliProjectLabel}=${labels[dockerCliProjectLabel]}`,
      "--label",
      `${dockerComposeProjectLabel}=${labels[dockerComposeProjectLabel]}`,
      networkMode,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  if (create.exitCode !== 0 && !create.stderr.includes("already exists")) {
    return yield* Effect.fail(new Error(`failed to create docker network: ${networkMode}`));
  }
});

export const ensureDockerNamedVolume = Effect.fnUntraced(function* (
  volumeName: string,
  projectId: string,
) {
  if (process.env["BITBUCKET_CLONE_DIR"] !== undefined) {
    return;
  }

  const labels = dockerProjectLabels(projectId);
  const create = yield* runChildProcess(
    "docker",
    [
      "volume",
      "create",
      "--label",
      `${dockerCliProjectLabel}=${labels[dockerCliProjectLabel]}`,
      "--label",
      `${dockerComposeProjectLabel}=${labels[dockerComposeProjectLabel]}`,
      volumeName,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  if (create.exitCode !== 0 && !create.stderr.includes("already exists")) {
    return yield* Effect.fail(new Error(`failed to create docker volume: ${volumeName}`));
  }
});

export const isDockerRunning = Effect.fnUntraced(function* () {
  const result = yield* runChildProcess("docker", ["info"], {
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));
  return result.exitCode === 0;
});

export function resolveEdgeRuntimeVersion(
  denoVersion: number | undefined,
  defaultVersion: string,
): Effect.Effect<string, Error> {
  if (denoVersion === undefined || denoVersion === 2) {
    return Effect.succeed(defaultVersion);
  }
  if (denoVersion === 1) {
    return Effect.succeed(DENO1_EDGE_RUNTIME_VERSION);
  }
  return Effect.fail(
    new Error(`Failed reading config: Invalid edge_runtime.deno_version: ${denoVersion}.`),
  );
}

/**
 * Formats a resolved edge-runtime version as a Docker tag, tolerating a
 * pin that's already `v`-prefixed. `resolveEdgeRuntimeVersion`'s own
 * defaults are bare (`"1.74.2"`, `DENO1_EDGE_RUNTIME_VERSION`), but a value
 * sourced from `supabase/.temp/edge-runtime-version` can legitimately be
 * either form — Go's `replaceImageTag` (`pkg/config/utils.go:81-84`) appends
 * the pin file's raw content verbatim after the image's `:`, and both forms
 * are exercised elsewhere in this codebase (`legacy-edge-runtime-image.ts`'s
 * own `replaceImageTag` port, and its and `services.integration.test.ts`'s
 * `"v9.9.9"` fixtures alongside `deploy.integration.test.ts`'s bare
 * `"9.9.9"`). Blindly prepending `v` — as every caller below did before this
 * helper existed — double-prefixes an already-`v`-prefixed pin
 * (`supabase/edge-runtime:vv9.9.9`), which docker then simply fails to pull.
 */
export function edgeRuntimeImageTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * Go: `DockerStart` -> `DockerResolveImageIfNotCached`/`DockerImagePullWithRetry`
 * (`internal/utils/docker.go:304-348,366-370`) — checks every registry
 * candidate (ECR/GHCR/Docker Hub) for a local cache hit first, then pulls
 * with 2 retries per candidate (4s/8s backoff), returning whichever
 * candidate answered. Shared by both shells' `functions` Docker paths
 * (`deploy`/`download`/`serve`) — `legacyGetRegistryImageUrl`'s single-URL
 * mapping is already called unconditionally by both today, so the retry is
 * strictly-better resilience, not a Go-only quirk.
 */
export const resolveFunctionsDockerImage = Effect.fnUntraced(function* (
  image: string,
  projectEnvValues?: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* legacyMakeDockerImageResolver(spawner, projectEnvValues)(image);
});
