import type { ServiceDef } from "@supabase/process-compose";
import { dockerPortMapArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

type PoolMode = "transaction" | "session";

interface DockerPoolerOptions extends ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly hostAdminPort: number;
  readonly hostPort: number;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly poolMode: PoolMode;
  readonly defaultPoolSize: number;
  readonly maxClientConn: number;
  readonly jwtSecret: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly platformOs: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const poolerHealthCheck = (port: number): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path: "/api/health",
    scheme: "http",
  },
  ...stackHealthBudgets.pooler,
});

const tenantScript = (
  opts: DockerPoolerOptions,
) => `{:ok, _} = Application.ensure_all_started(:supavisor)
{:ok, version} =
  case Supavisor.Repo.query!("select version()") do
    %{rows: [[ver]]} -> Supavisor.Helpers.parse_pg_version(ver)
    _ -> nil
  end

params = %{
  "external_id" => "${opts.tenantId}",
  "db_host" => "${opts.dbHost}",
  "db_port" => ${opts.dbPort},
  "db_database" => "postgres",
  "require_user" => false,
  "auth_query" => "SELECT * FROM pgbouncer.get_auth($1)",
  "default_max_clients" => ${opts.maxClientConn},
  "default_pool_size" => ${opts.defaultPoolSize},
  "default_parameter_status" => %{"server_version" => version},
  "users" => [%{
    "db_user" => "pgbouncer",
    "db_password" => "postgres",
    "mode_type" => "${opts.poolMode}",
    "pool_size" => ${opts.defaultPoolSize},
    "is_manager" => true
  }]
}

if !Supavisor.Tenants.get_tenant_by_external_id(params["external_id"]) do
  {:ok, _} = Supavisor.Tenants.create_tenant(params)
end`;

export const makePoolerServiceDocker = (opts: DockerPoolerOptions): ServiceDef =>
  (() => {
    return dockerRunService({
      runtime: opts.runtime,
      name: "pooler",
      identity: opts.identity,
      image: opts.image,
      networkArgs: dockerPortMapArgs(opts.platformOs, [
        { host: opts.hostAdminPort, container: poolerContainerPorts.admin },
        {
          host: opts.hostPort,
          container:
            opts.poolMode === "session"
              ? poolerContainerPorts.session
              : poolerContainerPorts.transaction,
        },
      ]),
      env: {
        PORT: String(poolerContainerPorts.admin),
        PROXY_PORT_SESSION: String(poolerContainerPorts.session),
        PROXY_PORT_TRANSACTION: String(poolerContainerPorts.transaction),
        DATABASE_URL: `ecto://postgres:postgres@${opts.dbHost}:${opts.dbPort}/_supabase`,
        CLUSTER_POSTGRES: "true",
        SECRET_KEY_BASE: opts.secretKeyBase,
        VAULT_ENC_KEY: opts.encryptionKey,
        API_JWT_SECRET: opts.jwtSecret,
        METRICS_JWT_SECRET: opts.jwtSecret,
        REGION: "local",
        RUN_JANITOR: "true",
        ERL_AFLAGS: "-proto_dist inet_tcp",
        RLIMIT_NOFILE: "",
      },
      cmd: [
        "/bin/sh",
        "-c",
        `/app/bin/migrate && /app/bin/supavisor eval '${tenantScript(opts)}' && /app/bin/server`,
      ],
      dependencies: opts.dependencies,
      healthCheck: poolerHealthCheck(opts.hostAdminPort),
    });
  })();

export const poolerContainerPorts = {
  admin: 4000,
  session: 5432,
  transaction: 6543,
} as const;
