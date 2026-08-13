import type { ExternalCleanupAction, ServiceDef } from "@supabase/process-compose";
import type { ServiceName } from "../ServiceName.ts";
import { dockerContainerName, STACK_ID_LABEL, type StackIdentity } from "../StackIdentity.ts";
import { dockerServiceCleanup, dockerServiceOrphanCleanup } from "./docker-cleanup.ts";

export interface ServiceDependency {
  readonly service: string;
  readonly condition: "healthy" | "completed";
}

interface DockerRunServiceOptions {
  readonly name: ServiceName;
  readonly identity: StackIdentity;
  readonly image: string;
  readonly networkArgs?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly args?: ReadonlyArray<string>;
  readonly cmd?: ReadonlyArray<string>;
  readonly entrypoint?: string;
  readonly volumes?: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
  readonly healthCheck?: ServiceDef["healthCheck"];
  readonly restart?: ServiceDef["restart"];
  readonly shutdown?: ServiceDef["shutdown"];
  readonly orphanCleanup?: ReadonlyArray<ExternalCleanupAction>;
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
  containerName: string,
  command: string,
  args: ReadonlyArray<string>,
  opts: Omit<ServiceDef["healthCheck"], "probe"> = {},
): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Exec",
    command: "docker",
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
    // The label survives any change to how names are built, so a stack's
    // containers stay findable by the identity that owns them.
    ...(opts.identity.stackId === undefined
      ? []
      : ["--label", `${STACK_ID_LABEL}=${opts.identity.stackId}`]),
    ...(opts.networkArgs ?? []),
    ...(opts.volumes ?? []).flatMap((volume) => ["-v", volume]),
    ...(opts.entrypoint === undefined ? [] : ["--entrypoint", opts.entrypoint]),
    ...(opts.args ?? []),
    ...envArgs(opts.env ?? {}),
    opts.image,
    ...(opts.cmd ?? []),
  ];

  return {
    name: opts.name,
    command: "docker",
    args: dockerArgs,
    dependencies: opts.dependencies,
    healthCheck: opts.healthCheck,
    shutdown: opts.shutdown,
    cleanup: dockerServiceCleanup(containerName),
    supervision: {
      orphanCleanup: [...dockerServiceOrphanCleanup(containerName), ...(opts.orphanCleanup ?? [])],
    },
    restart: opts.restart ?? "unless-stopped",
  };
};
