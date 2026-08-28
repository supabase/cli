// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env -- Synchronous Docker socket discovery runs before Effect runtime construction and preserves the service's sync API.

import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { dockerNetworkArgs } from "../Platform.ts";
import type { ContainerRuntime } from "../ContainerRuntime.ts";
import { dockerContainerName, type StackIdentity } from "../StackIdentity.ts";
import { Effect, FileSystem } from "effect";
import { StackBuildError } from "../errors.ts";
import { nativeLogRoot, nativeServiceLogPath } from "../NativeLogWriter.ts";
import {
  dockerExecHealthCheck,
  dockerRunService,
  hostHttpHealthCheck,
  nativeRunService,
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

export interface NativeVectorOptions {
  readonly binPath: string;
  readonly runtimeRoot: string;
  /** Port for Vector's private administrative HTTP API and health endpoint. */
  readonly adminPort: number;
  readonly analyticsPort: number;
  readonly analyticsApiKey: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface VectorConfigPreparationOptions {
  readonly runtimeRoot: string;
  readonly adminPort: number;
  readonly analyticsPort: number;
  readonly analyticsApiKey: string;
}

export interface PreparedVectorConfig {
  readonly configPath: string;
  readonly dataDir: string;
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

const yamlString = (value: string): string => JSON.stringify(value);

const nativeVectorConfig = (opts: VectorConfigPreparationOptions): string => {
  const logRoot = nativeLogRoot(opts.runtimeRoot);
  const vectorLogPath = nativeServiceLogPath(opts.runtimeRoot, "vector");
  const include = [
    `${logRoot}/*.jsonl`,
    `${logRoot}/*.jsonl.1`,
    `${logRoot}/*.jsonl.2`,
    `${logRoot}/*.jsonl.3`,
  ];
  const exclude = [vectorLogPath, `${vectorLogPath}.1`, `${vectorLogPath}.2`, `${vectorLogPath}.3`];

  return `data_dir: ${yamlString(join(opts.runtimeRoot, "vector", "data_dir"))}

api:
  enabled: true
  address: ${yamlString(`127.0.0.1:${opts.adminPort}`)}

sources:
  native_logs:
    type: file
    include:
${include.map((path) => `      - ${yamlString(path)}`).join("\n")}
    exclude:
${exclude.map((path) => `      - ${yamlString(path)}`).join("\n")}
    read_from: beginning
    decoding:
      codec: json

sinks:
  logflare:
    type: http
    inputs:
      - native_logs
    encoding:
      codec: json
    method: post
    request:
      retry_max_duration_secs: 10
      headers:
        x-api-key: ${yamlString(opts.analyticsApiKey)}
    uri: ${yamlString(`http://127.0.0.1:${opts.analyticsPort}/api/logs?source_name=native.logs.local`)}
`;
};

const vectorRuntimePaths = (runtimeRoot: string): PreparedVectorConfig => ({
  configPath: join(runtimeRoot, "vector", "vector.yaml"),
  dataDir: join(runtimeRoot, "vector", "data_dir"),
});

/** Materialize Vector's per-stack config and checkpoint directory. */
export const prepareVectorConfig = (
  opts: VectorConfigPreparationOptions,
): Effect.Effect<PreparedVectorConfig, StackBuildError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = vectorRuntimePaths(opts.runtimeRoot);
    yield* fs
      .makeDirectory(join(opts.runtimeRoot, "vector"), {
        recursive: true,
        mode: 0o700,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new StackBuildError({
              detail: "Failed to create the native Vector runtime directory",
              cause,
            }),
        ),
      );
    yield* fs.makeDirectory(paths.dataDir, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(
        (cause) =>
          new StackBuildError({
            detail: "Failed to create the native Vector checkpoint directory",
            cause,
          }),
      ),
    );
    yield* fs
      .writeFileString(paths.configPath, nativeVectorConfig(opts), {
        flag: "w",
        mode: 0o600,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new StackBuildError({
              detail: "Failed to write the native Vector configuration",
              cause,
            }),
        ),
      );
    return paths;
  });

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
      `cat <<'EOF' > /etc/vector/vector.yaml && exec vector --config /etc/vector/vector.yaml
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

export const makeVectorServiceNative = (opts: NativeVectorOptions) => {
  const paths = vectorRuntimePaths(opts.runtimeRoot);
  return nativeRunService({
    name: "vector",
    command: `${opts.binPath}/bin/vector`,
    args: ["--config", paths.configPath],
    env: { VECTOR_THREADS: "1" },
    dependencies: opts.dependencies,
    healthCheck: hostHttpHealthCheck(opts.adminPort, "/health", {
      ...stackHealthBudgets.vector,
    }),
  });
};
