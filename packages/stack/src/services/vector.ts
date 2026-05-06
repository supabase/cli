import { existsSync } from "node:fs";
import {
  dockerExecHealthCheck,
  dockerRunService,
  type ServiceDependency,
} from "./service-utils.ts";

interface DockerVectorOptions {
  readonly image: string;
  readonly apiPort: number;
  readonly serviceHost: string;
  readonly analyticsPort: number;
  readonly analyticsApiKey: string;
  readonly networkArgs: ReadonlyArray<string>;
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
  const containerName = `supabase-vector-${opts.apiPort}`;
  const dockerSocket = process.env.DOCKER_HOST?.startsWith("unix://")
    ? process.env.DOCKER_HOST.slice("unix://".length)
    : "/var/run/docker.sock";
  const volumes = existsSync(dockerSocket) ? [`${dockerSocket}:/var/run/docker.sock:ro`] : [];

  return dockerRunService({
    name: "vector",
    containerName,
    image: opts.image,
    networkArgs: opts.networkArgs,
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
    dependsOn: opts.dependencies,
    healthCheck: dockerExecHealthCheck(
      containerName,
      "sh",
      ["-ec", "wget -q -O /dev/null http://127.0.0.1:9001/health"],
      {
        initialDelaySeconds: 1,
        periodSeconds: 1,
        failureThreshold: 30,
      },
    ),
  });
};
