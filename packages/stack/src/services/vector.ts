// oxlint-disable effecttsgo/node-builtin-import -- Pure path/config helpers use the host path API at a synchronous platform boundary.
// oxlint-disable effecttsgo/process-env -- Docker/Podman socket discovery intentionally reads host runtime environment at the platform boundary.
import { accessSync, constants } from "node:fs";
import { dockerNetworkArgs } from "../Platform.ts";
import type { ContainerRuntime } from "../ContainerRuntime.ts";
import { dockerContainerName, type StackIdentity } from "../StackIdentity.ts";
import {
  dockerExecHealthCheck,
  dockerRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface DockerVectorOptions extends ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly serviceHost: string;
  readonly analyticsPort: number;
  readonly analyticsApiKey: string;
  readonly platformOs: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const vectorConfig = (
  host: string,
  port: number,
  apiKey: string,
  logSource: "docker_logs" | "internal_logs",
) => `api:
  enabled: true
  address: 0.0.0.0:9001

sources:
  runtime:
    type: ${logSource}

sinks:
  logflare:
    type: http
    inputs:
      - runtime
    encoding:
      codec: json
    method: post
    request:
      retry_max_duration_secs: 10
      headers:
        x-api-key: "${apiKey}"
    uri: "http://${host}:${port}/api/logs?source_name=docker.logs.local"
`;

const canAccessSocket = (socket: string): boolean => {
  try {
    accessSync(socket, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const unixSocketFromEnv = (value: string | undefined): string | undefined => {
  if (value === undefined || !value.startsWith("unix://")) return undefined;
  const socket = value.slice("unix://".length);
  return socket.length > 0 && canAccessSocket(socket) ? socket : undefined;
};

const podmanSocketCandidates = (): ReadonlyArray<string> => {
  const candidates: Array<string> = [];
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir !== undefined && runtimeDir.length > 0) {
    candidates.push(`${runtimeDir}/podman/podman.sock`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined) candidates.push(`/run/user/${uid}/podman/podman.sock`);
  candidates.push("/run/podman/podman.sock");
  return candidates;
};

const resolveVectorDockerSocket = (runtime: ContainerRuntime): string | undefined => {
  if (runtime === "podman") {
    const explicitPodmanSocket = unixSocketFromEnv(process.env.CONTAINER_HOST);
    if (explicitPodmanSocket !== undefined) return explicitPodmanSocket;
    const explicitDockerSocket = unixSocketFromEnv(process.env.DOCKER_HOST);
    if (explicitDockerSocket !== undefined) return explicitDockerSocket;
    return podmanSocketCandidates().find(canAccessSocket);
  }

  const explicitDockerSocket = unixSocketFromEnv(process.env.DOCKER_HOST);
  if (explicitDockerSocket !== undefined) return explicitDockerSocket;
  return canAccessSocket("/var/run/docker.sock") ? "/var/run/docker.sock" : undefined;
};

export const makeVectorServiceDocker = (opts: DockerVectorOptions) => {
  const containerName = dockerContainerName("vector", opts.identity.key);
  const socketPath = resolveVectorDockerSocket(opts.runtime);
  const volumes = socketPath === undefined ? [] : [`${socketPath}:/var/run/docker.sock:ro`];

  return dockerRunService({
    runtime: opts.runtime,
    name: "vector",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, []),
    volumes,
    securityOptions: opts.runtime === "podman" && socketPath !== undefined ? ["label=disable"] : [],
    env: socketPath === undefined ? {} : { DOCKER_HOST: "unix:///var/run/docker.sock" },
    entrypoint: "sh",
    cmd: [
      "-c",
      `cat <<'EOF' > /etc/vector/vector.yaml && vector --config /etc/vector/vector.yaml
${vectorConfig(
  opts.serviceHost,
  opts.analyticsPort,
  opts.analyticsApiKey,
  socketPath === undefined ? "internal_logs" : "docker_logs",
)}EOF
`,
    ],
    dependencies: opts.dependencies,
    healthCheck: dockerExecHealthCheck(
      opts.runtime,
      containerName,
      "sh",
      ["-ec", "wget -q -O /dev/null http://127.0.0.1:9001/health"],
      {
        ...stackHealthBudgets.vector,
      },
    ),
  });
};
