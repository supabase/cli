import type { ServiceDef } from "@supabase/process-compose";
import { dockerServiceCleanup, dockerServiceOrphanCleanup } from "./docker-cleanup.ts";

export interface ServiceDependency {
  readonly service: string;
  readonly condition: "healthy" | "completed";
}

interface DockerRunServiceOptions {
  readonly name: string;
  readonly containerName: string;
  readonly image: string;
  readonly networkArgs?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly args?: ReadonlyArray<string>;
  readonly cmd?: ReadonlyArray<string>;
  readonly entrypoint?: string;
  readonly volumes?: ReadonlyArray<string>;
  readonly dependsOn?: ReadonlyArray<ServiceDependency>;
  readonly healthCheck?: ServiceDef["healthCheck"];
  readonly restart?: ServiceDef["restart"];
  readonly shutdown?: ServiceDef["shutdown"];
  readonly orphanCleanup?: ReadonlyArray<any>;
}

// Name-only `-e KEY` flags: docker reads each value from the docker CLI's own
// environment (ServiceDef.env, merged over the parent env at spawn), so
// secrets like DB passwords and JWT keys never appear in the `docker run`
// argv, which any local user can read via ps / /proc/<pid>/cmdline.
const envArgs = (env: Record<string, string>): ReadonlyArray<string> =>
  Object.keys(env).flatMap((key) => ["-e", key]);

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
  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    opts.containerName,
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
    env: opts.env,
    dependencies: opts.dependsOn,
    healthCheck: opts.healthCheck,
    shutdown: opts.shutdown,
    cleanup: dockerServiceCleanup(opts.containerName),
    supervision: {
      orphanCleanup: [
        ...dockerServiceOrphanCleanup(opts.containerName),
        ...(opts.orphanCleanup ?? []),
      ],
    },
    restart: opts.restart ?? "unless-stopped",
  };
};
