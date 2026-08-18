import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  hostHttpHealthCheck,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import bootstrapSource from "./edge-runtime-main.ts" with { type: "text" };
import { stackHealthBudgets } from "./health-budgets.ts";

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

interface DockerEdgeRuntimeOptions extends EdgeRuntimeOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
}

const bootstrapFileName = "index.ts";
const bootstrapMountDir = "/workspace";
const bootstrapSourcePath = new URL("./edge-runtime-main.ts", import.meta.url);
const resolvedBootstrapSource =
  bootstrapSource === "" ? readFileSync(bootstrapSourcePath, "utf8") : bootstrapSource;

function ensureBootstrapScript(runtimeRoot: string): string {
  const bootstrapDir = join(runtimeRoot, "edge-runtime");
  mkdirSync(bootstrapDir, { recursive: true });
  const filePath = join(bootstrapDir, bootstrapFileName);
  writeFileSync(filePath, resolvedBootstrapSource);
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
    ...stackHealthBudgets.edgeRuntime,
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
    runtime: opts.runtime,
    name: "edge-runtime",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
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
    dependencies: opts.dependencies,
    healthCheck: edgeRuntimeHealthCheck(opts.port),
  });
};
