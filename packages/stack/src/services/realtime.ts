import type { ServiceDef } from "@supabase/process-compose";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";

interface DockerRealtimeOptions {
  readonly image: string;
  readonly port: number;
  readonly apiPort: number;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly jwtSecret: string;
  readonly jwtJwks: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly maxHeaderLength: number;
  readonly networkArgs: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const realtimeHealthCheck = (port: number, tenantId: string): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Exec",
    command: "curl",
    args: [
      "-sSfL",
      "--head",
      "-o",
      "/dev/null",
      "-H",
      `Host:${tenantId}`,
      `http://127.0.0.1:${port}/api/ping`,
    ],
  },
  initialDelaySeconds: 1,
  periodSeconds: 0.5,
  failureThreshold: 30,
});

export const makeRealtimeServiceDocker = (opts: DockerRealtimeOptions): ServiceDef =>
  dockerRunService({
    name: "realtime",
    containerName: `supabase-realtime-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
    env: {
      PORT: String(opts.port),
      DB_HOST: opts.dbHost,
      DB_PORT: String(opts.dbPort),
      DB_USER: "postgres",
      DB_PASSWORD: "postgres",
      DB_NAME: "postgres",
      DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
      DB_ENC_KEY: opts.encryptionKey,
      API_JWT_SECRET: opts.jwtSecret,
      API_JWT_JWKS: opts.jwtJwks,
      METRICS_JWT_SECRET: opts.jwtSecret,
      APP_NAME: "realtime",
      SECRET_KEY_BASE: opts.secretKeyBase,
      ERL_AFLAGS: "-proto_dist inet_tcp",
      DNS_NODES: "",
      RLIMIT_NOFILE: "",
      SEED_SELF_HOST: "true",
      RUN_JANITOR: "true",
      MAX_HEADER_LENGTH: String(opts.maxHeaderLength),
    },
    dependsOn: opts.dependencies,
    healthCheck: realtimeHealthCheck(opts.port, opts.tenantId),
  });
