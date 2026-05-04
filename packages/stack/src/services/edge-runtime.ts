import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceDef } from "@supabase/process-compose";
import { dockerRunService, hostHttpHealthCheck, type ServiceDependency } from "./service-utils.ts";

interface EdgeRuntimeOptions {
  readonly runtimeRoot: string;
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
const bootstrapContainerPath = `${bootstrapMountDir}/${bootstrapFileName}`;

const bootstrapSource = `const placeholder = {
  code: "FUNCTIONS_NOT_CONFIGURED",
  message: "Edge Functions are not configured for this local stack yet.",
};

Deno.serve((req) => {
  const url = new URL(req.url);

  if (url.pathname === "/_internal/health") {
    return Response.json({ message: "ok" });
  }

  return Response.json(placeholder, { status: 501 });
});
`;

function ensureBootstrapScript(runtimeRoot: string): string {
  const bootstrapDir = join(runtimeRoot, "edge-runtime");
  mkdirSync(bootstrapDir, { recursive: true });
  const filePath = join(bootstrapDir, bootstrapFileName);
  writeFileSync(filePath, bootstrapSource);
  return filePath;
}

const edgeRuntimeEnv = (opts: EdgeRuntimeOptions): Record<string, string> => ({
  ...opts.env,
  EDGE_RUNTIME_INSPECTOR_PORT: String(opts.inspectorPort),
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
  ensureBootstrapScript(opts.runtimeRoot);
  const bootstrapDir = join(opts.runtimeRoot, "edge-runtime");

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
  const bootstrapHostPath = ensureBootstrapScript(opts.runtimeRoot);

  return dockerRunService({
    name: "edge-runtime",
    containerName: `supabase-edge-runtime-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
    volumes: [`${bootstrapHostPath}:${bootstrapContainerPath}:ro`],
    env: edgeRuntimeEnv(opts),
    cmd: [...edgeRuntimeArgs(opts, bootstrapMountDir)],
    dependsOn: opts.dependencies,
    healthCheck: edgeRuntimeHealthCheck(opts.port),
  });
};
