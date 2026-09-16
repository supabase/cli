/**
 * Vector container spec builder, gated on `config.analytics.enabled` by the caller.
 *
 * Vector inspects the host's own Docker daemon endpoint to decide how to mount or reach it from
 * inside its container for the `docker_logs` source. That resolution splits into two pieces:
 * {@link resolveDockerDaemonHost} discovers the daemon host string, and
 * {@link resolveVectorDockerSocketPlan} branches on its scheme to decide the `DOCKER_HOST`
 * override, bind mount, and `--security-opt` — Docker Desktop, Colima, OrbStack, and rootless
 * Podman each take a different branch.
 */

import { Effect, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";
import {
  slimWgetHealthcheck,
  slimWgetWaitCommand,
} from "../../../command-internal/db-bootstrap/slim-runtime.ts";
import { usesSlimImageRuntime } from "../../../shared/services/slim-images.ts";
import { platformDefaultDockerHost } from "../../../command-internal/hostname.ts";
import { renderStartVectorYaml } from "../lib/template-render.ts";

type Spawner = ChildProcessSpawner["Service"];

/** The Vector network alias — a fixed, non-configurable constant. */
const VECTOR_NETWORK_ALIASES = ["vector"];

/** The well-known Docker-Desktop-for-{Mac,Windows}/Colima/OrbStack hostname that resolves to the host machine from inside a container. */
const DIND_HOST = "host.docker.internal";

/** The default port `dindHost` targets before a `tcp` daemon host's own port overrides it. */
const DIND_DEFAULT_PORT = "2375";

export interface ParsedDockerHostUrl {
  readonly scheme: string;
  readonly host: string;
}

/**
 * Splits a Docker host string of the form `scheme://addr`; for a `tcp` host, strips any
 * path/query so `.host` is exactly the `host:port` pair. Throws on a string with no `://`
 * separator or an empty address.
 */
export function parseDockerHostUrl(host: string): ParsedDockerHostUrl {
  const separatorIndex = host.indexOf("://");
  if (separatorIndex === -1) {
    throw new Error(`unable to parse docker host \`${host}\``);
  }
  const scheme = host.slice(0, separatorIndex);
  const addr = host.slice(separatorIndex + 3);
  if (addr.length === 0) {
    throw new Error(`unable to parse docker host \`${host}\``);
  }
  if (scheme === "tcp") {
    const pathIndex = addr.indexOf("/");
    return { scheme, host: pathIndex === -1 ? addr : addr.slice(0, pathIndex) };
  }
  return { scheme, host: addr };
}

/**
 * Extracts the port from a Docker `tcp://` host string (`host:port` or `[ipv6]:port`); returns
 * `undefined` when there's no trailing `:<digits>`.
 */
export function splitHostPortPort(hostPort: string): string | undefined {
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon === -1) return undefined;
  const port = hostPort.slice(lastColon + 1);
  return /^\d+$/.test(port) ? port : undefined;
}

/**
 * Recognizes the rootful-socket paths Docker Desktop for Mac (`.docker/run`, the older
 * `.docker/desktop`) and Colima expose, which must bind `/var/run/docker.sock` instead of the
 * detected path directly. Anything else (Podman, OrbStack, a bare Linux socket) is bindable as-is.
 */
export function shouldMountRootDockerSocket(host: string): boolean {
  return (
    host.endsWith("/.docker/run/docker.sock") ||
    host.endsWith("/.docker/desktop/docker.sock") ||
    (host.includes("/.colima/") && host.endsWith("/docker.sock")) ||
    host.endsWith("/.colima/docker.sock")
  );
}

export interface VectorDockerSocketPlan {
  /** The `DOCKER_HOST` env override — empty for the `unix` scheme, which sets no override at all. */
  readonly env: Readonly<Record<string, string>>;
  /** Bind mounts — only ever populated by the `unix` scheme's two sub-branches. */
  readonly binds: ReadonlyArray<string>;
  /** Security options — only the `unix`/non-root sub-branch sets `label:disable`. */
  readonly securityOpt: ReadonlyArray<string>;
  /**
   * True for the `npipe` scheme: this container is still created and started, but the caller
   * must exclude it from the health-wait list. This module's builder does not act on the flag
   * itself.
   */
  readonly isNpipe: boolean;
}

/**
 * The pure decision of what `DOCKER_HOST` env override, bind mount, and `--security-opt` Vector's
 * container needs to reach the real Docker daemon from inside itself, given an already-resolved
 * daemon host string (see {@link resolveDockerDaemonHost}):
 *
 * - `tcp` — proxies through `host.docker.internal` on the daemon host's own port, falling back to
 *   the default DinD port `2375` when unparseable.
 * - `npipe` (Windows) — same `host.docker.internal:2375` proxy target; a stderr warning belongs
 *   to the caller, since output side effects don't belong in a pure spec builder.
 * - `unix` — no env override; mounts the daemon socket read-only instead. Docker Desktop/Colima's
 *   known rootful-socket paths ({@link shouldMountRootDockerSocket}) bind the standard
 *   `/var/run/docker.sock` to itself; anything else (Podman, OrbStack) binds the detected socket
 *   path onto the standard path plus `--security-opt label:disable`, needed for a differently
 *   labeled socket to be readable inside the container.
 */
export function resolveVectorDockerSocketPlan(
  daemonHost: string,
  platform: NodeJS.Platform = process.platform,
): VectorDockerSocketPlan {
  const parsed = parseDockerHostUrl(daemonHost);
  const env: Record<string, string> = {};
  const binds: Array<string> = [];
  const securityOpt: Array<string> = [];

  switch (parsed.scheme) {
    case "tcp": {
      const port = splitHostPortPort(parsed.host) ?? DIND_DEFAULT_PORT;
      env.DOCKER_HOST = `http://${DIND_HOST}:${port}`;
      break;
    }
    case "npipe": {
      env.DOCKER_HOST = `http://${DIND_HOST}:${DIND_DEFAULT_PORT}`;
      break;
    }
    case "unix": {
      const defaultParsed = parseDockerHostUrl(platformDefaultDockerHost(platform));
      if (shouldMountRootDockerSocket(parsed.host)) {
        binds.push(`${defaultParsed.host}:${defaultParsed.host}:ro`);
      } else {
        binds.push(`${parsed.host}:${defaultParsed.host}:ro`);
        securityOpt.push("label:disable");
      }
      break;
    }
  }

  return { env, binds, securityOpt, isNpipe: parsed.scheme === "npipe" };
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
 * Best-effort resolution of the current docker CLI context's daemon endpoint via
 * `docker context inspect`, rather than reimplementing Docker's context store file format. Does
 * not fall back to `podman` (unlike `spawnContainerCli`): its `context inspect` output has no
 * equivalent `Endpoints.docker.Host` shape, and a Podman-only host is expected to set
 * `DOCKER_HOST` directly, checked first by {@link resolveDockerDaemonHost}.
 */
function inspectDockerContextHost(spawner: Spawner): Effect.Effect<string, string> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            "docker",
            ["context", "inspect", "--format", "{{ .Endpoints.docker.Host }}"],
            { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
          ),
        )
        .pipe(Effect.mapError(() => "failed to spawn docker"));
      const [exitCode, stdout] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stdout)],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError(() => "failed to read docker context inspect output"));
      if (exitCode !== 0) {
        return yield* Effect.fail("docker context inspect exited non-zero");
      }
      const host = stdout.trim();
      if (host.length === 0) {
        return yield* Effect.fail("docker context inspect returned an empty host");
      }
      return host;
    }),
  );
}

/**
 * Discovers the daemon host string {@link resolveVectorDockerSocketPlan} branches on: an explicit
 * `DOCKER_HOST` env var wins first; otherwise the current docker context's own endpoint via
 * {@link inspectDockerContextHost} (Docker Desktop, Colima, and OrbStack all select a non-default
 * context rather than setting `DOCKER_HOST`); finally this platform's bare default socket/pipe
 * path when neither source resolves.
 */
export function resolveDockerDaemonHost(
  spawner: Spawner,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<string> {
  const fromEnv = env.DOCKER_HOST;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return Effect.succeed(fromEnv);
  }
  return inspectDockerContextHost(spawner).pipe(
    Effect.orElseSucceed(() => platformDefaultDockerHost(platform)),
  );
}

const VECTOR_HEALTHCHECK = {
  test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:9001/health"],
  intervalSeconds: 10,
  timeoutSeconds: 2,
  retries: 3,
} as const;

/**
 * Writes the rendered `vector.yaml` via a `cat <<'EOF'` heredoc, waits on Logflare's `/health`
 * (sinks would otherwise start too early), then `exec`s Vector so it stays PID 1. A TERM trap
 * covers the wait so `docker stop` does not burn 10s if Logflare is still down; `-T 2` bounds each
 * probe so a hung health endpoint can't defer the trap. Slim Vector ships BusyBox wget, so the
 * wait uses `-q --spider` instead of GNU's `--no-verbose --tries`.
 */
export function buildVectorEntrypointScript(
  vectorYaml: string,
  logflareId: string,
  opts: { readonly slim?: boolean } = {},
): string {
  const wget = opts.slim
    ? slimWgetWaitCommand(`http://${logflareId}:4000/health`)
    : `wget --no-verbose --tries=1 -T 2 --spider http://${logflareId}:4000/health`;
  return (
    "cat <<'EOF' > /etc/vector/vector.yaml\n" +
    vectorYaml +
    "\nEOF\ntrap 'exit 143' TERM\nuntil " +
    wget +
    " 2>/dev/null; do sleep 2; done\ntrap - TERM\nexec vector --config /etc/vector/vector.yaml\n"
  );
}

export interface VectorContainerSpecInput {
  /** `config.analytics.vector_image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `serviceContainerName("vector", projectId)`, also used as the `vector.yaml` template's `vectorId` field. */
  readonly containerName: string;
  /** The shared Docker network every `start` container joins. */
  readonly networkId: string;
  /** `config.analytics.api_key` — the `x-api-key` header value every `vector.yaml` sink sends to Logflare. */
  readonly apiKey: string;
  /** Used both as a `vector.yaml` template field and in the entrypoint's `wget` wait-loop URL. */
  readonly logflareId: string;
  /** Kong's own container id — a `vector.yaml` template field. */
  readonly kongId: string;
  /** GoTrue's own container id — a `vector.yaml` template field. */
  readonly gotrueId: string;
  /** PostgREST's own container id — a `vector.yaml` template field. */
  readonly restId: string;
  /** Realtime's own container id — unlike Kong's `kong.yml`, `vector.yaml` uses the container id here, not the tenant id. */
  readonly realtimeId: string;
  /** Storage's own container id — a `vector.yaml` template field. */
  readonly storageId: string;
  /** Edge Runtime's own container id — a `vector.yaml` template field. */
  readonly edgeRuntimeId: string;
  /** The local Postgres container's own name. */
  readonly dbId: string;
  /** Already-resolved via {@link resolveDockerDaemonHost} + {@link resolveVectorDockerSocketPlan}, keeping this builder a pure function of its `input`. */
  readonly dockerSocketPlan: VectorDockerSocketPlan;
}

/** Builds Vector's {@link StartContainerSpec}. */
export function buildVectorContainerSpec(input: VectorContainerSpecInput): StartContainerSpec {
  const slim = usesSlimImageRuntime(input.image);
  const vectorYaml = renderStartVectorYaml({
    apiKey: input.apiKey,
    vectorId: input.containerName,
    logflareId: input.logflareId,
    kongId: input.kongId,
    gotrueId: input.gotrueId,
    restId: input.restId,
    realtimeId: input.realtimeId,
    storageId: input.storageId,
    edgeRuntimeId: input.edgeRuntimeId,
    dbId: input.dbId,
  });

  return {
    image: input.image,
    containerName: input.containerName,
    env: input.dockerSocketPlan.env,
    entrypoint: "sh",
    cmd: ["-c", buildVectorEntrypointScript(vectorYaml, input.logflareId, { slim })],
    binds: input.dockerSocketPlan.binds,
    healthcheck: slim ? slimWgetHealthcheck("http://127.0.0.1:9001/health") : VECTOR_HEALTHCHECK,
    restartPolicy: "unless-stopped",
    securityOpt: input.dockerSocketPlan.securityOpt,
    networkId: input.networkId,
    networkAliases: VECTOR_NETWORK_ALIASES,
    labels: {},
  };
}
