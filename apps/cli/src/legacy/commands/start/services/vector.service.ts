/**
 * Vector container spec builder, gated on
 * `config.analytics.enabled && !isContainerExcluded(config.analytics.vector_image,
 * excluded)` — see `legacy-service-catalog.ts`'s `vector` entry
 * (`excludeKey: "vector"`, depends on `logflare` being healthy). Gating and
 * image resolution/pre-pull are the caller's job (a future `start.handler.ts`);
 * this module only assembles the container spec once the caller has already
 * decided to start it, matching `docker-create-args.ts`'s "image already
 * resolved/pulled" contract.
 *
 * Vector is the one `start` service that inspects the HOST's own Docker
 * daemon endpoint to decide how to mount/reach that daemon's socket from
 * INSIDE the Vector container for its `docker_logs` source. That decision is
 * split into two independently exported, independently testable pieces,
 * matching every other `start` service's "builder stays pure" shape:
 *
 * - {@link legacyResolveDockerDaemonHost} — the one IMPURE piece: discovers
 *   the current `scheme://host` string a caller should feed into the pure
 *   branch below. See its doc comment for exactly what it reads/shells out to
 *   and why.
 * - {@link legacyResolveVectorDockerSocketPlan} — the PURE scheme-branching
 *   logic: given an already-resolved daemon host string, decides the
 *   `DOCKER_HOST` env override, bind mount, and `--security-opt` this
 *   container needs. This is the highest-parity-risk logic in this module —
 *   Docker Desktop, Colima, OrbStack, and rootless Podman each take a
 *   different branch.
 *
 * {@link legacyBuildVectorContainerSpec} itself stays a pure function of an
 * already-resolved {@link LegacyVectorDockerSocketPlan}, exactly like every
 * other `start`-service builder in this directory.
 */

import { Effect, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";
import { legacyRenderStartVectorYaml } from "../lib/template-render.ts";

type Spawner = ChildProcessSpawner["Service"];

/** The Vector network alias — a fixed, non-configurable constant. */
const LEGACY_VECTOR_NETWORK_ALIASES = ["vector"];

/** The well-known Docker-Desktop-for-{Mac,Windows}/Colima/OrbStack hostname that resolves to the host machine from inside a container. */
const LEGACY_DIND_HOST = "host.docker.internal";

/** The default port `dindHost` targets before a `tcp` daemon host's own port overrides it. */
const LEGACY_DIND_DEFAULT_PORT = "2375";

export interface LegacyParsedDockerHostUrl {
  readonly scheme: string;
  readonly host: string;
}

/**
 * Splits a Docker host string of the form `scheme://addr` and, for a `tcp`
 * host, strips any path/query so `.host` is exactly the `host:port` pair —
 * docker host strings never carry a path in practice. Throws on a string
 * with no `://` separator or an empty address — the daemon host resolved by
 * {@link legacyResolveDockerDaemonHost} is always a well-formed `scheme://`
 * string in practice, so this should never actually throw outside a test
 * feeding it garbage on purpose.
 */
export function legacyParseDockerHostUrl(host: string): LegacyParsedDockerHostUrl {
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
 * Extracts the port from a Docker `tcp://` host string, covering exactly the
 * shapes it can take (`host:port` or `[ipv6]:port`) — only the port is ever
 * needed here, so this returns just that (`undefined` when the string has no
 * trailing `:<digits>`).
 */
export function legacySplitHostPortPort(hostPort: string): string | undefined {
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon === -1) return undefined;
  const port = hostPort.slice(lastColon + 1);
  return /^\d+$/.test(port) ? port : undefined;
}

/**
 * Recognizes the KNOWN rootful-socket paths Docker Desktop for Mac
 * (`.docker/run` and the older `.docker/desktop`) and Colima expose, where
 * binding the STANDARD `/var/run/docker.sock` path (handled specially by
 * those runtimes, "under the hood") is required instead of binding the
 * detected path directly. Anything else (Podman, OrbStack, a bare Linux
 * socket) is assumed bindable-as-is.
 */
export function legacyShouldMountRootDockerSocket(host: string): boolean {
  return (
    host.endsWith("/.docker/run/docker.sock") ||
    host.endsWith("/.docker/desktop/docker.sock") ||
    (host.includes("/.colima/") && host.endsWith("/docker.sock")) ||
    host.endsWith("/.colima/docker.sock")
  );
}

/**
 * The platform-default Docker host: `platform` defaults to
 * `process.platform`.
 */
export function legacyPlatformDefaultDockerHost(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
}

export interface LegacyVectorDockerSocketPlan {
  /** The `DOCKER_HOST` env override — empty for the `unix` scheme, which sets no override at all. */
  readonly env: Readonly<Record<string, string>>;
  /** Bind mounts — only ever populated by the `unix` scheme's two sub-branches. */
  readonly binds: ReadonlyArray<string>;
  /** Security options — only the `unix`/non-root sub-branch sets `label:disable`. */
  readonly securityOpt: ReadonlyArray<string>;
  /**
   * True for the `npipe` scheme: the Vector container still gets created and
   * started on this branch, but — uniquely among every `start` service — it
   * is NOT added to the health-wait list a later `WaitForHealthyService`
   * call waits on. Orchestration-only signal for a future
   * `start.handler.ts`; this module's builder does not act on it.
   */
  readonly isNpipe: boolean;
}

/**
 * The pure decision of what `DOCKER_HOST` env override, bind mount, and
 * `--security-opt` Vector's container needs to reach the REAL Docker daemon
 * from inside its own container, given an already-resolved daemon host
 * string (see {@link legacyResolveDockerDaemonHost} for how a caller obtains
 * one):
 *
 * - `tcp` — proxy through `host.docker.internal` on the SAME port the daemon
 *   host itself specified (falling back to the default DinD port `2375` when
 *   the host string has no parseable port).
 * - `npipe` (Windows) — same `host.docker.internal:2375` proxy target; a
 *   stderr warning belongs here too, which is this module's caller's
 *   responsibility (output side effects don't belong in a pure spec
 *   builder).
 * - `unix` — no env override; instead mounts the daemon socket read-only.
 *   Docker Desktop/Colima's KNOWN rootful-socket paths
 *   ({@link legacyShouldMountRootDockerSocket}) get the STANDARD
 *   `/var/run/docker.sock` bound to itself (that path is special-cased by
 *   those runtimes "under the hood") — the ACTUAL detected path is never
 *   used as the bind source in this sub-branch. Anything else (Podman,
 *   OrbStack) binds the actual detected socket path onto the standard path
 *   instead, plus `--security-opt label:disable` (needed for Podman/
 *   OrbStack's differently-labeled socket to be readable from inside a
 *   container with a different SELinux/AppArmor label).
 */
export function legacyResolveVectorDockerSocketPlan(
  daemonHost: string,
  platform: NodeJS.Platform = process.platform,
): LegacyVectorDockerSocketPlan {
  const parsed = legacyParseDockerHostUrl(daemonHost);
  const env: Record<string, string> = {};
  const binds: Array<string> = [];
  const securityOpt: Array<string> = [];

  switch (parsed.scheme) {
    case "tcp": {
      const port = legacySplitHostPortPort(parsed.host) ?? LEGACY_DIND_DEFAULT_PORT;
      env.DOCKER_HOST = `http://${LEGACY_DIND_HOST}:${port}`;
      break;
    }
    case "npipe": {
      env.DOCKER_HOST = `http://${LEGACY_DIND_HOST}:${LEGACY_DIND_DEFAULT_PORT}`;
      break;
    }
    case "unix": {
      const defaultParsed = legacyParseDockerHostUrl(legacyPlatformDefaultDockerHost(platform));
      if (legacyShouldMountRootDockerSocket(parsed.host)) {
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
 * Best-effort resolution of the CURRENT docker CLI context's daemon
 * endpoint, WITHOUT reimplementing Docker's context store file format —
 * `docker context inspect` already performs that exact resolution (context
 * name from `$DOCKER_CONTEXT`/`~/.docker/config.json`'s `currentContext`,
 * then that context's stored endpoint) using the same `docker` binary this
 * CLI already shells out to elsewhere. Deliberately does NOT fall back to
 * `podman` (unlike `spawnContainerCli`): Podman's own `context inspect`
 * output has no equivalent `Endpoints.docker.Host` shape, and a Podman-only
 * host is expected to set `DOCKER_HOST` directly (checked first by
 * {@link legacyResolveDockerDaemonHost}, before this ever runs).
 */
function legacyInspectDockerContextHost(spawner: Spawner): Effect.Effect<string, string> {
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
 * Discovers the daemon host string {@link legacyResolveVectorDockerSocketPlan}
 * branches on: an explicit `DOCKER_HOST` env var always wins (checked first,
 * no shell-out needed); otherwise the CURRENT docker context's own endpoint
 * (Docker Desktop, Colima, and OrbStack all select a non-default context
 * rather than setting `DOCKER_HOST`) via {@link legacyInspectDockerContextHost};
 * finally this platform's bare default socket/pipe path when neither source
 * resolves (no context support, `docker` missing —
 * `legacyEnsureImagesCached`/`spawnContainerCli` will already have surfaced a
 * clearer "docker not found" error earlier in a real `start` run if that's
 * the actual cause).
 */
export function legacyResolveDockerDaemonHost(
  spawner: Spawner,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<string> {
  const fromEnv = env.DOCKER_HOST;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return Effect.succeed(fromEnv);
  }
  return legacyInspectDockerContextHost(spawner).pipe(
    Effect.orElseSucceed(() => legacyPlatformDefaultDockerHost(platform)),
  );
}

const LEGACY_VECTOR_HEALTHCHECK = {
  test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:9001/health"],
  intervalSeconds: 10,
  timeoutSeconds: 2,
  retries: 3,
} as const;

/**
 * Builds the Vector entrypoint script: writes the rendered `vector.yaml` via
 * a `cat <<'EOF'` heredoc, then blocks on a `wget`-poll loop against
 * Logflare's own `/health` endpoint (Vector's `docker_logs`/HTTP sinks would
 * otherwise start before Logflare is ready to receive them) before finally
 * exec'ing `vector`.
 */
export function legacyBuildVectorEntrypointScript(vectorYaml: string, logflareId: string): string {
  return (
    "cat <<'EOF' > /etc/vector/vector.yaml\n" +
    vectorYaml +
    "\nEOF\nuntil wget --no-verbose --tries=1 --spider http://" +
    logflareId +
    ":4000/health 2>/dev/null; do sleep 2; done\nvector --config /etc/vector/vector.yaml\n"
  );
}

export interface LegacyVectorContainerSpecInput {
  /** `config.analytics.vector_image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `legacyServiceContainerName("vector", projectId)` — also the `vectorConfig.VectorId` template field. */
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
  /** Realtime's own container id — UNLIKE Kong's `kong.yml`, Vector's `vector.yaml` really does use Realtime's container id here, not the tenant id. */
  readonly realtimeId: string;
  /** Storage's own container id — a `vector.yaml` template field. */
  readonly storageId: string;
  /** Edge Runtime's own container id — a `vector.yaml` template field. */
  readonly edgeRuntimeId: string;
  /** The local Postgres container's own name. */
  readonly dbId: string;
  /** Already-resolved via {@link legacyResolveDockerDaemonHost} + {@link legacyResolveVectorDockerSocketPlan}, keeping this builder a pure function of its `input`. */
  readonly dockerSocketPlan: LegacyVectorDockerSocketPlan;
}

/**
 * Assembles Vector's {@link LegacyStartContainerSpec}. Pure — no Effect or
 * ambient I/O — matching every other `start`-service builder in this
 * directory.
 */
export function legacyBuildVectorContainerSpec(
  input: LegacyVectorContainerSpecInput,
): LegacyStartContainerSpec {
  const vectorYaml = legacyRenderStartVectorYaml({
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
    cmd: ["-c", legacyBuildVectorEntrypointScript(vectorYaml, input.logflareId)],
    binds: input.dockerSocketPlan.binds,
    healthcheck: LEGACY_VECTOR_HEALTHCHECK,
    restartPolicy: "unless-stopped",
    securityOpt: input.dockerSocketPlan.securityOpt,
    networkId: input.networkId,
    networkAliases: LEGACY_VECTOR_NETWORK_ALIASES,
    labels: {},
  };
}
