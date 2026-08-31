import type { ExternalCleanupAction, ServiceDef } from "@supabase/process-compose";
import type { ServiceName } from "../ServiceName.ts";
import type { ContainerRuntime } from "../ContainerRuntime.ts";
import { dockerContainerName, STACK_ID_LABEL, type StackIdentity } from "../StackIdentity.ts";
import { dockerServiceCleanup, dockerServiceOrphanCleanup } from "./docker-cleanup.ts";

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
}

export interface NativeRunServiceOptions {
  /**
   * Native definitions may include private one-shot helpers that are not part
   * of the public service catalog (for example Realtime's migration step).
   */
  readonly name: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
  readonly posixResourceLimits?: ServiceDef["posixResourceLimits"];
  readonly healthCheck?: ServiceDef["healthCheck"];
  readonly shutdown?: ServiceDef["shutdown"];
  readonly restart?: ServiceDef["restart"];
}

/** Keep native Erlang distribution on the owning stack's loopback interface. */
export const nativeBeamLoopbackEnv = {
  ERL_AFLAGS: "-proto_dist inet_tcp -kernel inet_dist_use_interface '{127,0,0,1}'",
  ERL_EPMD_ADDRESS: "127.0.0.1",
} as const;

export const nativeRunService = (opts: NativeRunServiceOptions): ServiceDef => ({
  name: opts.name,
  command: opts.command,
  ...(opts.args === undefined ? {} : { args: opts.args }),
  ...(opts.env === undefined ? {} : { env: opts.env }),
  ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  dependencies: opts.dependencies,
  ...(opts.posixResourceLimits === undefined
    ? {}
    : { posixResourceLimits: opts.posixResourceLimits }),
  ...(opts.healthCheck === undefined ? {} : { healthCheck: opts.healthCheck }),
  ...(opts.shutdown === undefined ? {} : { shutdown: opts.shutdown }),
  supervision: {},
  restart: opts.restart ?? "unless-stopped",
});

export const hostUserForLinuxDocker = (
  runtime: ContainerRuntime,
  platformOs: string,
): string | undefined => {
  // Linux bind mounts preserve numeric ownership. Matching the caller keeps
  // private runtime files readable and persistent data removable by the host.
  if (runtime !== "docker" || platformOs !== "linux") return undefined;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
};

const envArgs = (env: Record<string, string>): ReadonlyArray<string> =>
  Object.keys(env).flatMap((key) => ["-e", key]);

export const hostHttpHealthCheck = (
  port: number,
  path: string,
  opts: Omit<NonNullable<ServiceDef["healthCheck"]>, "probe"> & {
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): ServiceDef["healthCheck"] => {
  const { headers, ...healthCheck } = opts;
  return {
    probe: {
      _tag: "Http",
      host: "127.0.0.1",
      port,
      path,
      scheme: "http",
      ...(headers === undefined ? {} : { headers }),
    },
    ...healthCheck,
  };
};

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
    env: opts.env,
    dependencies: opts.dependencies,
    healthCheck: opts.healthCheck,
    shutdown: opts.shutdown,
    cleanup: dockerServiceCleanup(opts.runtime, containerName),
    supervision: {
      orphanCleanup: [
        ...dockerServiceOrphanCleanup(opts.runtime, containerName),
        ...(opts.orphanCleanup ?? []),
      ],
    },
    restart: opts.restart ?? "unless-stopped",
  };
};
