// oxlint-disable-next-line effecttsgo/node-builtin-import -- Bootstrap source paths are resolved synchronously for the generated Docker mount boundary.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceDef } from "@supabase/process-compose";
import { Effect, FileSystem } from "effect";
import { dockerNetworkArgs } from "../Platform.ts";
import { StackBuildError } from "../errors.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  hostUserForLinuxDocker,
  hostHttpHealthCheck,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import bootstrapSource from "./edge-runtime-main.ts" with { type: "text" };
import { stackHealthBudgets } from "./health-budgets.ts";
import { edgeRuntimeNofileSoftLimit, edgeRuntimeNofileUlimit } from "./nofile-limit.ts";

interface EdgeRuntimeOptions {
  readonly runtimeRoot: string;
  readonly projectDir?: string;
  readonly port: number;
  readonly inspectorPort: number;
  readonly policy: "oneshot" | "per_worker";
  readonly env: Readonly<Record<string, string>>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativeEdgeRuntimeOptions extends Omit<EdgeRuntimeOptions, "projectDir"> {
  readonly binPath: string;
  readonly bootstrapDir: string;
  readonly projectDir: string;
}

interface DockerEdgeRuntimeOptions extends EdgeRuntimeOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
  readonly bootstrapDir: string;
}

const bootstrapFileName = "index.ts";
const bootstrapMountDir = "/workspace";
const bootstrapSourcePath = fileURLToPath(new URL("./edge-runtime-main.ts", import.meta.url));

export const prepareEdgeRuntimeBootstrap = (
  runtimeRoot: string,
): Effect.Effect<string, StackBuildError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bootstrapDir = join(runtimeRoot, "edge-runtime");
    yield* fs.makeDirectory(bootstrapDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new StackBuildError({
            detail: "Failed to create the Edge Runtime bootstrap directory",
            cause,
          }),
      ),
    );
    const source =
      bootstrapSource === ""
        ? yield* fs.readFileString(bootstrapSourcePath).pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: "Failed to read the Edge Runtime bootstrap script",
                  cause,
                }),
            ),
          )
        : bootstrapSource;
    yield* fs.writeFileString(join(bootstrapDir, bootstrapFileName), source).pipe(
      Effect.mapError(
        (cause) =>
          new StackBuildError({
            detail: "Failed to write the Edge Runtime bootstrap script",
            cause,
          }),
      ),
    );
    return bootstrapDir;
  });

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

export const makeEdgeRuntimeServiceDocker = (opts: DockerEdgeRuntimeOptions): ServiceDef => {
  return dockerRunService({
    runtime: opts.runtime,
    name: "edge-runtime",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    volumes: [
      `${opts.bootstrapDir}:${bootstrapMountDir}:ro`,
      ...(opts.projectDir === undefined ? [] : [`${opts.projectDir}:${opts.projectDir}:ro`]),
    ],
    args: ["--ulimit", edgeRuntimeNofileUlimit(opts.platformOs).arg],
    env: {
      ...edgeRuntimeEnv(opts),
      FUNCTIONS_RUNTIME_CONFIG_PATH: `${bootstrapMountDir}/functions-runtime-config.json`,
    },
    user: hostUserForLinuxDocker(opts.runtime, opts.platformOs),
    cmd: [...edgeRuntimeArgs(opts, bootstrapMountDir)],
    dependencies: opts.dependencies,
    healthCheck: edgeRuntimeHealthCheck(opts.port),
  });
};

export const makeEdgeRuntimeServiceNative = (opts: NativeEdgeRuntimeOptions): ServiceDef =>
  nativeRunService({
    name: "edge-runtime",
    command: `${opts.binPath}/bin/.edge-runtime-wrapped`,
    args: [...edgeRuntimeArgs(opts, opts.bootstrapDir)],
    cwd: opts.projectDir,
    env: edgeRuntimeEnv(opts),
    posixResourceLimits: { nofileSoft: edgeRuntimeNofileSoftLimit },
    dependencies: opts.dependencies,
    healthCheck: edgeRuntimeHealthCheck(opts.port),
  });
