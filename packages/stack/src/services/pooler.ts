// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native crash dumps are rooted in the caller-owned runtime directory.
import { join } from "node:path";
import type { ServiceDef } from "@supabase/process-compose";
import { dockerPortMapArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

type PoolMode = "transaction" | "session";

interface PoolerServiceOptions {
  readonly dbHost: string;
  readonly dbPort: number;
  readonly poolMode: PoolMode;
  readonly defaultPoolSize: number;
  readonly maxClientConn: number;
  readonly jwtSecret: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativePoolerOptions extends Omit<PoolerServiceOptions, "dbHost"> {
  readonly binPath: string;
  readonly runtimeRoot: string;
  readonly adminPort: number;
  readonly sessionPort: number;
  readonly transactionPort: number;
  /** Base of the eight private Supavisor shard listeners (four per mode). */
  readonly internalPort: number;
}

export interface NativePoolerServiceBundle {
  /** Runs the bundled Supavisor migration once before tenant bootstrap. */
  readonly migrate: ServiceDef;
  /** Idempotently creates the local tenant after migrations complete. */
  readonly bootstrap: ServiceDef;
  /** The public, long-running Supavisor server. */
  readonly server: ServiceDef;
}

interface DockerPoolerOptions extends PoolerServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
  readonly hostAdminPort: number;
  readonly hostSessionPort: number;
  readonly hostTransactionPort: number;
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

/** Encode an untrusted StackConfig value as an Elixir double-quoted string. */
const elixirStringLiteral = (value: string): string => {
  let escaped = "";
  const characters = Array.from(value);
  for (const [index, character] of characters.entries()) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    switch (codePoint) {
      case 0x08:
        escaped += "\\b";
        break;
      case 0x09:
        escaped += "\\t";
        break;
      case 0x0a:
        escaped += "\\n";
        break;
      case 0x0c:
        escaped += "\\f";
        break;
      case 0x0d:
        escaped += "\\r";
        break;
      case 0x22:
        escaped += '\\"';
        break;
      case 0x5c:
        escaped += "\\\\";
        break;
      case 0x23:
        escaped += characters[index + 1] === "{" ? "\\#" : character;
        break;
      default:
        escaped +=
          codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0xd800 && codePoint <= 0xdfff)
            ? `\\u${codePoint.toString(16).padStart(4, "0")}`
            : character;
    }
  }
  return `"${escaped}"`;
};

/** Keep the generated eval source a single shell argument for Docker. */
const shellSingleQuoted = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const tenantScript = (
  opts: Pick<
    PoolerServiceOptions,
    "tenantId" | "dbHost" | "dbPort" | "maxClientConn" | "defaultPoolSize" | "poolMode"
  >,
) => `{:ok, _} = Application.ensure_all_started(:supavisor)
{:ok, version} =
  case Supavisor.Repo.query!("select version()") do
    %{rows: [[ver]]} -> Supavisor.Helpers.parse_pg_version(ver)
    _ -> nil
  end

params = %{
  "external_id" => ${elixirStringLiteral(opts.tenantId)},
  "db_host" => ${elixirStringLiteral(opts.dbHost)},
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
    "mode_type" => ${elixirStringLiteral(opts.poolMode)},
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
        { host: opts.hostSessionPort, container: poolerContainerPorts.session },
        { host: opts.hostTransactionPort, container: poolerContainerPorts.transaction },
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
        `/app/bin/migrate && /app/bin/supavisor eval ${shellSingleQuoted(
          tenantScript({
            tenantId: opts.tenantId,
            dbHost: opts.dbHost,
            dbPort: opts.dbPort,
            poolMode: opts.poolMode,
            defaultPoolSize: opts.defaultPoolSize,
            maxClientConn: opts.maxClientConn,
          }),
        )} && /app/bin/server`,
      ],
      dependencies: opts.dependencies,
      healthCheck: poolerHealthCheck(opts.hostAdminPort),
    });
  })();

const poolerNativeShardPorts = (basePort: number, offset: number): string =>
  Array.from({ length: 4 }, (_, index) => String(basePort + offset + index)).join(",");

const poolerNativeEnv = (opts: NativePoolerOptions): Record<string, string> => ({
  PORT: String(opts.adminPort),
  PROXY_PORT_SESSION: String(opts.sessionPort),
  PROXY_PORT_TRANSACTION: String(opts.transactionPort),
  SESSION_PROXY_PORTS: poolerNativeShardPorts(opts.internalPort, 0),
  TRANSACTION_PROXY_PORTS: poolerNativeShardPorts(opts.internalPort, 4),
  DATABASE_URL: `ecto://postgres:postgres@127.0.0.1:${opts.dbPort}/_supabase`,
  CLUSTER_POSTGRES: "true",
  SECRET_KEY_BASE: opts.secretKeyBase,
  VAULT_ENC_KEY: opts.encryptionKey,
  API_JWT_SECRET: opts.jwtSecret,
  METRICS_JWT_SECRET: opts.jwtSecret,
  REGION: "local",
  RUN_JANITOR: "true",
  RELEASE_DISTRIBUTION: "none",
  RLIMIT_NOFILE: "",
  ELIXIR_ERL_OPTIONS: "+fnu +S 1:1 +SDio 1 +sbwt none +sbwtdcpu none +sbwtdio none",
  ERL_CRASH_DUMP: join(opts.runtimeRoot, "pooler", "erl_crash.dump"),
});

export const makePoolerServicesNative = (opts: NativePoolerOptions): NativePoolerServiceBundle => {
  const env = poolerNativeEnv(opts);
  const bootstrapEnv = {
    ...env,
    PORT: "0",
    PROXY_PORT: "0",
    PROXY_PORT_SESSION: "0",
    PROXY_PORT_TRANSACTION: "0",
  };
  const migrate = nativeRunService({
    name: "pooler-migrate",
    command: `${opts.binPath}/bin/migrate`,
    env,
    dependencies: opts.dependencies,
    restart: "no",
  });
  const bootstrap = nativeRunService({
    name: "pooler-bootstrap",
    command: `${opts.binPath}/bin/supavisor`,
    args: ["eval", tenantScript({ ...opts, dbHost: "127.0.0.1" })],
    env: bootstrapEnv,
    dependencies: [{ service: migrate.name, condition: "completed" }],
    restart: "no",
  });
  const server = nativeRunService({
    name: "pooler",
    command: `${opts.binPath}/bin/server`,
    env,
    dependencies: [{ service: bootstrap.name, condition: "completed" }],
    healthCheck: poolerHealthCheck(opts.adminPort),
  });
  return { migrate, bootstrap, server };
};

export const poolerContainerPorts = {
  admin: 4000,
  session: 5432,
  transaction: 6543,
} as const;
