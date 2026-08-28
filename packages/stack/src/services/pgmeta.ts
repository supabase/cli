import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface PgmetaServiceOptions {
  readonly port: number;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativePgmetaOptions extends Omit<PgmetaServiceOptions, "dbHost"> {
  readonly binPath: string;
}

interface DockerPgmetaOptions extends PgmetaServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
}

const pgmetaEnv = (
  opts: Omit<PgmetaServiceOptions, "dbHost"> & { readonly dbHost?: string },
): Record<string, string> => ({
  PG_META_PORT: String(opts.port),
  PG_META_DB_HOST: opts.dbHost ?? "127.0.0.1",
  PG_META_DB_NAME: "postgres",
  PG_META_DB_USER: "postgres",
  PG_META_DB_PORT: String(opts.dbPort),
  PG_META_DB_PASSWORD: "postgres",
});

const pgmetaHealthCheck = (port: number): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path: "/health",
    scheme: "http",
  },
  ...stackHealthBudgets.pgmeta,
});

export const makePgmetaServiceDocker = (opts: DockerPgmetaOptions): ServiceDef =>
  dockerRunService({
    runtime: opts.runtime,
    name: "pgmeta",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    env: pgmetaEnv(opts),
    dependencies: opts.dependencies,
    healthCheck: pgmetaHealthCheck(opts.port),
  });

export const makePgmetaServiceNative = (opts: NativePgmetaOptions): ServiceDef =>
  nativeRunService({
    name: "pgmeta",
    command: `${opts.binPath}/bin/pgmeta`,
    env: pgmetaEnv(opts),
    dependencies: opts.dependencies,
    healthCheck: pgmetaHealthCheck(opts.port),
  });
