import type { ServiceDef } from "@supabase/process-compose";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";

interface DockerPgmetaOptions {
  readonly image: string;
  readonly apiPort: number;
  readonly port: number;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly networkArgs: ReadonlyArray<string>;
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
  initialDelaySeconds: 1,
  periodSeconds: 0.5,
  failureThreshold: 30,
});

export const makePgmetaServiceDocker = (opts: DockerPgmetaOptions): ServiceDef =>
  dockerRunService({
    name: "pgmeta",
    containerName: `supabase-pgmeta-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
    env: {
      PG_META_PORT: String(opts.port),
      PG_META_DB_HOST: opts.dbHost,
      PG_META_DB_NAME: "postgres",
      PG_META_DB_USER: "postgres",
      PG_META_DB_PORT: String(opts.dbPort),
      PG_META_DB_PASSWORD: "postgres",
    },
    dependsOn: opts.dependencies,
    healthCheck: pgmetaHealthCheck(opts.port),
  });
