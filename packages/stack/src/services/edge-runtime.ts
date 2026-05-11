import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceDef } from "@supabase/process-compose";
import { dockerRunService, hostHttpHealthCheck, type ServiceDependency } from "./service-utils.ts";

interface EdgeRuntimeOptions {
  readonly runtimeRoot: string;
  readonly projectDir?: string;
  readonly port: number;
  readonly inspectorPort: number;
  readonly policy: "oneshot" | "per_worker";
  readonly env: Readonly<Record<string, string>>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

interface NativeEdgeRuntimeOptions extends EdgeRuntimeOptions {
  readonly binPath: string;
}

interface DockerEdgeRuntimeOptions extends EdgeRuntimeOptions {
  readonly image: string;
  readonly apiPort: number;
  readonly networkArgs: ReadonlyArray<string>;
}

const bootstrapFileName = "index.ts";
const bootstrapMountDir = "/workspace";
const bootstrapSourcePath = new URL("./edge-runtime-main.ts", import.meta.url);

function ensureBootstrapScript(runtimeRoot: string): string {
  const bootstrapDir = join(runtimeRoot, "edge-runtime");
  mkdirSync(bootstrapDir, { recursive: true });
  const filePath = join(bootstrapDir, bootstrapFileName);
  writeFileSync(filePath, readFileSync(bootstrapSourcePath, "utf8"));
  return bootstrapDir;
}

const edgeRuntimeEnv = (opts: EdgeRuntimeOptions): Record<string, string> => ({
  ...opts.env,
  EDGE_RUNTIME_PORT: String(opts.port),
  EDGE_RUNTIME_INSPECTOR_PORT: String(opts.inspectorPort),
  FUNCTIONS_RUNTIME_CONFIG_PATH: join(
    opts.runtimeRoot,
    "edge-runtime",
    "functions-runtime-config.json",
  ),
});

const edgeRuntimeArgs = (
  opts: Pick<EdgeRuntimeOptions, "port" | "policy">,
  mainServicePath: string,
): ReadonlyArray<string> => [
  "start",
  `--main-service=${mainServicePath}`,
  `--port=${opts.port}`,
  `--policy=${opts.policy}`,
];

const edgeRuntimeHealthCheck = (port: number): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/_internal/health", {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    failureThreshold: 30,
  });

export const makeEdgeRuntimeServiceNative = (opts: NativeEdgeRuntimeOptions): ServiceDef => {
  const bootstrapDir = ensureBootstrapScript(opts.runtimeRoot);

  return {
    name: "edge-runtime",
    command: `${opts.binPath}/bin/edge-runtime`,
    args: [...edgeRuntimeArgs(opts, bootstrapDir)],
    env: edgeRuntimeEnv(opts),
    dependencies: opts.dependencies,
    healthCheck: edgeRuntimeHealthCheck(opts.port),
    supervision: {},
    restart: "unless-stopped",
  };
};

export const makeEdgeRuntimeServiceDocker = (opts: DockerEdgeRuntimeOptions): ServiceDef => {
  const bootstrapDir = ensureBootstrapScript(opts.runtimeRoot);

  return dockerRunService({
    name: "edge-runtime",
    containerName: `supabase-edge-runtime-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
    volumes: [
      `${bootstrapDir}:${bootstrapMountDir}:ro`,
      ...(opts.projectDir === undefined ? [] : [`${opts.projectDir}:${opts.projectDir}:ro`]),
    ],
    args: ["--ulimit", "nofile=65536:65536"],
    env: {
      ...edgeRuntimeEnv(opts),
      FUNCTIONS_RUNTIME_CONFIG_PATH: `${bootstrapMountDir}/functions-runtime-config.json`,
    },
    cmd: [...edgeRuntimeArgs(opts, bootstrapMountDir)],
    dependsOn: opts.dependencies,
    healthCheck: edgeRuntimeHealthCheck(opts.port),
  });
};
