import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface DockerPgmetaOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly port: number;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly platformOs: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

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
    name: "pgmeta",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    env: {
      PG_META_PORT: String(opts.port),
      PG_META_DB_HOST: opts.dbHost,
      PG_META_DB_NAME: "postgres",
      PG_META_DB_USER: "postgres",
      PG_META_DB_PORT: String(opts.dbPort),
      PG_META_DB_PASSWORD: "postgres",
    },
    dependencies: opts.dependencies,
    healthCheck: pgmetaHealthCheck(opts.port),
  });
