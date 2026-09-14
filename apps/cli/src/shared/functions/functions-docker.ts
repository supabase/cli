// Docker orchestration primitives shared by `deploy.ts`, `download.ts`, and
// `serve.ts` (the `functions` family), plus
// `command-internal/db-bootstrap/container-lifecycle.ts` (a different
// family, using the generic `isUserDefinedDockerNetwork` predicate).
import { resolve } from "node:path";
import { Effect, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { spawnContainerCli } from "../../command-internal/container-cli.ts";
import { makeDockerImageResolver } from "../../command-internal/docker-image-resolve.ts";
import { DENO1_EDGE_RUNTIME_VERSION } from "./functions.shared.ts";

const INVALID_PROJECT_ID = /[^a-zA-Z0-9_.-]+/g;
const MAX_PROJECT_ID_LENGTH = 40;

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
 * The Deno-cache volume bind for an edge-runtime container. Both image
 * families now run as root, so the shared `supabase_edge_runtime_<projectId>`
 * volume mounts at `/root/.cache/deno`.
 */
export function edgeRuntimeCacheVolume(projectId: string) {
  const name = localDockerId("edge_runtime", projectId);
  const containerPath = "/root/.cache/deno";
  return {
    name,
    containerPath,
    bind: `${name}:${containerPath}:rw`,
  };
}

/**
 * Resolves the Docker network mode. `explicit` is tri-state: `undefined`
 * (never set) falls through to `envOverride`; `""` (explicitly cleared) and
 * any non-empty value both skip `envOverride` and resolve immediately.
 * Callers must pass a flag reader that preserves this distinction — see
 * `lastExplicitLongFlagValue` (`shared/cli/cobra-flag-groups.ts`).
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

/**
 * In-memory tar bytes for `docker cp - <container>:/` delivery, which needs no
 * daemon-visible host path. Keys are absolute container paths; leading slashes
 * are stripped into the tar entry names since the archive extracts at the
 * container root. `Bun.Archive` exposes no per-entry mode option, so entries
 * carry its `0644` default.
 */
export function containerArchiveBytes(
  files: Readonly<Record<string, string>>,
): Promise<Uint8Array> {
  return new Bun.Archive(
    Object.fromEntries(
      Object.entries(files).map(([containerPath, content]) => [
        containerPath.replace(/^\/+/, ""),
        content,
      ]),
    ),
  ).bytes();
}

export interface FunctionsDockerRunSpec {
  /** Already registry/pull-resolved image reference. */
  readonly image: string;
  /** The label value applied to the container. */
  readonly projectId: string;
  readonly networkMode: string;
  readonly binds: ReadonlyArray<string>;
  /** `KEY=VALUE` entries, each emitted as `-e KEY=VALUE`. */
  readonly env?: ReadonlyArray<string>;
  /** Emitted as `-w <dir>`; optional because only the bundler container sets a working directory. */
  readonly workingDir?: string;
  /** argv after the image, e.g. `["bundle", "--entrypoint", …]`. */
  readonly containerArgs: ReadonlyArray<string>;
  readonly platform?: NodeJS.Platform;
}

/**
 * Assembles the one-shot `docker run` invocation shared by `deploy.ts`'s
 * bundler and `download.ts`'s unbundler containers: binds, network, the
 * linux `host.docker.internal` workaround, env, and the unconditional
 * `com.supabase.cli.project`/`com.docker.compose.project` labels — applied
 * to the container itself (not just the network/volume it depends on) so
 * label-based cleanup/inspection can find an orphaned container.
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
  if (spec.workingDir !== undefined) {
    command.push("-w", spec.workingDir);
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

// Decodes a byte stream to text, accumulating the full text (returned, for
// callers that post-process it, e.g. scanning stderr for "invalid eszip
// v2") while also tee-ing each decoded chunk to `onChunk` as it arrives.
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

// Falls back to `podman` on Docker-less hosts via `spawnContainerCli`.
// `Effect.scoped` closes the spawn's own scope as soon as the process exits
// and both streams drain — without it, a release finalizer would leak into
// the caller's scope, and `functions serve`'s session-long restart loop
// would accumulate one per docker invocation.
export const runChildProcess = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  opts: {
    /** Streamed to the child's stdin (e.g. a `docker cp -` tar archive); defaults to no stdin. */
    readonly stdin?: Stream.Stream<Uint8Array>;
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
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawnContainerCli(spawner, [...args], {
        stdin: opts.stdin ?? "ignore",
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
    }),
  );
});

// Docker's `--network container:<name|id>` syntax (attaching to another
// container's network stack) is recognized by a bare "container:" prefix
// before the first `:`, regardless of what follows.
function isContainerDockerNetworkMode(networkMode: string) {
  const separatorIndex = networkMode.indexOf(":");
  return separatorIndex !== -1 && networkMode.slice(0, separatorIndex) === "container";
}

// A "user-defined" network is any mode besides default/bridge/host/none/
// container:<id>. Omitting the container exclusion would make network
// creation try to inspect/create a network named "container:<id>", which
// isn't a real network — that mode passes straight through to the
// container's own NetworkMode instead.
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

/**
 * Resolves the edge-runtime image tag (fed verbatim into `edgeRuntimeImage`).
 * `defaultVersion` is the `.temp/edge-runtime-version` pin when present, else
 * the Dockerfile default tag; `deno_version = 1` overrides either with the
 * deno-1 image tag.
 */
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
 * Resolves a functions Docker image, checking every registry candidate
 * (ECR/GHCR/Docker Hub) for a local cache hit first, then pulling with 2
 * retries per candidate (4s/8s backoff) and returning whichever candidate
 * answered. Shared by every `functions` Docker path (`deploy`, `download`,
 * `serve`).
 */
export const resolveFunctionsDockerImage = Effect.fnUntraced(function* (
  image: string,
  projectEnvValues?: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeDockerImageResolver(spawner, projectEnvValues)(image);
});
