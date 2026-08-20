import type { ExternalCleanupAction, ServiceDef } from "@supabase/process-compose";
import type { ServiceName } from "../ServiceName.ts";
import type { ContainerRuntime } from "../ContainerRuntime.ts";
import { dockerContainerName, STACK_ID_LABEL, type StackIdentity } from "../StackIdentity.ts";
import {
  dockerServiceCleanup,
  dockerServiceOrphanCleanup,
  type DockerDataOwnershipCleanup,
} from "./docker-cleanup.ts";

export interface ServiceDependency {
  readonly service: string;
  readonly condition: "healthy" | "completed";
}

export interface ContainerRuntimeOptions {
  readonly runtime: ContainerRuntime;
}

interface DockerRunServiceOptions extends ContainerRuntimeOptions {
  readonly name: ServiceName;
  readonly identity: StackIdentity;
  readonly image: string;
  readonly networkArgs?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly args?: ReadonlyArray<string>;
  readonly cmd?: ReadonlyArray<string>;
  readonly entrypoint?: string;
  readonly volumes?: ReadonlyArray<string>;
  readonly securityOptions?: ReadonlyArray<string>;
  readonly user?: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
  readonly healthCheck?: ServiceDef["healthCheck"];
  readonly restart?: ServiceDef["restart"];
  readonly shutdown?: ServiceDef["shutdown"];
  readonly orphanCleanup?: ReadonlyArray<ExternalCleanupAction>;
  readonly cleanup?: DockerDataOwnershipCleanup;
}

const envArgs = (env: Record<string, string>): ReadonlyArray<string> =>
  Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);

export const hostHttpHealthCheck = (
  port: number,
  path: string,
  opts: Omit<ServiceDef["healthCheck"], "probe"> = {},
): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path,
    scheme: "http",
  },
  ...opts,
});

export const dockerExecHealthCheck = (
  runtime: ContainerRuntime,
  containerName: string,
  command: string,
  args: ReadonlyArray<string>,
  opts: Omit<ServiceDef["healthCheck"], "probe"> = {},
): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Exec",
    command: runtime,
    args: ["exec", containerName, command, ...args],
  },
  ...opts,
});

export const dockerRunService = (opts: DockerRunServiceOptions): ServiceDef => {
  const containerName = dockerContainerName(opts.name, opts.identity.key);
  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    // Keep the identity available to a future label-keyed cleanup path when a
    // caller supplies it; current cleanup removes the exact name below.
    ...(opts.identity.stackId === undefined
      ? []
      : ["--label", `${STACK_ID_LABEL}=${opts.identity.stackId}`]),
    ...(opts.networkArgs ?? []),
    ...(opts.volumes ?? []).flatMap((volume) => ["-v", volume]),
    ...(opts.securityOptions ?? []).flatMap((option) => ["--security-opt", option]),
    ...(opts.user === undefined ? [] : ["--user", opts.user]),
    ...(opts.entrypoint === undefined ? [] : ["--entrypoint", opts.entrypoint]),
    ...(opts.args ?? []),
    ...envArgs(opts.env ?? {}),
    opts.image,
    ...(opts.cmd ?? []),
  ];

  return {
    name: opts.name,
    command: opts.runtime,
    args: dockerArgs,
    dependencies: opts.dependencies,
    healthCheck: opts.healthCheck,
    shutdown: opts.shutdown,
    cleanup: dockerServiceCleanup(opts.runtime, containerName, opts.cleanup),
    supervision: {
      orphanCleanup: [
        ...dockerServiceOrphanCleanup(opts.runtime, containerName, opts.cleanup),
        ...(opts.orphanCleanup ?? []),
      ],
    },
    restart: opts.restart ?? "unless-stopped",
  };
};
