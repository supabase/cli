import { existsSync } from "node:fs";
import { dockerNetworkArgs } from "../Platform.ts";
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

const VECTOR_CONFIG = (host: string, port: number, apiKey: string) => `api:
  enabled: true
  address: 0.0.0.0:9001

sources:
  docker:
    type: docker_logs

sinks:
  logflare:
    type: http
    inputs:
      - docker
    encoding:
      codec: json
    method: post
    request:
      retry_max_duration_secs: 10
      headers:
        x-api-key: "${apiKey}"
    uri: "http://${host}:${port}/api/logs?source_name=docker.logs.local"
`;

export const makeVectorServiceDocker = (opts: DockerVectorOptions) => {
  const containerName = dockerContainerName("vector", opts.identity.key);
  const dockerSocket = process.env.DOCKER_HOST?.startsWith("unix://")
    ? process.env.DOCKER_HOST.slice("unix://".length)
    : "/var/run/docker.sock";
  const volumes = existsSync(dockerSocket) ? [`${dockerSocket}:/var/run/docker.sock:ro`] : [];

  return dockerRunService({
    runtime: opts.runtime,
    name: "vector",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, []),
    volumes,
    env: {
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
    entrypoint: "sh",
    cmd: [
      "-c",
      `cat <<'EOF' > /etc/vector/vector.yaml && vector --config /etc/vector/vector.yaml
${VECTOR_CONFIG(opts.serviceHost, opts.analyticsPort, opts.analyticsApiKey)}EOF
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
