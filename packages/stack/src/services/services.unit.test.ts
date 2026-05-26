import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyticsDockerRuntimeNetwork, makeAnalyticsServiceDocker } from "./analytics.ts";
import { makeAuthServiceNative, makeAuthServiceDocker } from "./auth.ts";
import { makeEdgeRuntimeServiceDocker, makeEdgeRuntimeServiceNative } from "./edge-runtime.ts";
import { makeImgproxyServiceDocker } from "./imgproxy.ts";
import { makeMailpitServiceDocker } from "./mailpit.ts";
import {
  makePostgresInitService,
  REVOKE_DEFAULT_DATA_API_PRIVILEGES_SQL,
} from "./postgres-init.ts";
import { makePostgresService, makePostgresServiceDocker } from "./postgres.ts";
import { makePostgrestService } from "./postgrest.ts";
import { makePoolerServiceDocker, poolerContainerPorts } from "./pooler.ts";
import { makeVectorServiceDocker } from "./vector.ts";
import { DEFAULT_VERSIONS, dockerImageForService } from "../versions.ts";

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const DB_PORT = 54322;
const API_PORT = 54321;
const POSTGRES_BIN_PATH = `/cache/postgres/${DEFAULT_VERSIONS.postgres}/darwin-arm64`;
const POSTGREST_BIN_PATH = `/cache/postgrest/${DEFAULT_VERSIONS.postgrest}/macos-aarch64`;
const AUTH_BIN_PATH = `/cache/auth/${DEFAULT_VERSIONS.auth}/arm64`;
const EDGE_RUNTIME_BIN_PATH = `/cache/edge-runtime/${DEFAULT_VERSIONS["edge-runtime"]}/aarch64-darwin`;
const LINUX_HOST_GATEWAY_ARGS = ["--add-host", "host.docker.internal:host-gateway"];

describe("makePostgresService", () => {
  it("creates a postgres ServiceDef with correct defaults", () => {
    const def = makePostgresService({
      binPath: POSTGRES_BIN_PATH,
      dataDir: "/tmp/supabase/data",
      port: DB_PORT,
    });

    expect(def.name).toBe("postgres");
    expect(def.command).toBe("bash");
    expect(def.args).toEqual([
      `${POSTGRES_BIN_PATH}/share/supabase-cli/bin/supabase-postgres-init.sh`,
      "-p",
      "54322",
      "-c",
      "wal_level=logical",
      "-c",
      "max_wal_senders=5",
      "-c",
      "max_replication_slots=5",
    ]);
    expect(def.env?.PGDATA).toBe("/tmp/supabase/data");
    expect(def.env?.POSTGRES_PASSWORD).toBe("postgres");
    expect(def.env?.DYLD_LIBRARY_PATH).toBe(`${POSTGRES_BIN_PATH}/lib`);
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Exec",
      command: `${POSTGRES_BIN_PATH}/bin/pg_isready`,
      args: ["-h", "127.0.0.1", "-p", "54322", "-U", "postgres"],
      env: {
        DYLD_LIBRARY_PATH: `${POSTGRES_BIN_PATH}/lib`,
        LD_LIBRARY_PATH: `${POSTGRES_BIN_PATH}/lib`,
      },
    });
    expect(def.dependencies).toBeUndefined();
    expect(def.restart).toBe("unless-stopped");
    expect(def.supervision).toBeDefined();
  });
});

describe("analyticsDockerRuntimeNetwork", () => {
  it("uses the container port behind Docker port mapping on Linux", () => {
    expect(analyticsDockerRuntimeNetwork("linux", 54328, "host.docker.internal")).toEqual({
      listenPort: 4000,
      nodeHost: "0.0.0.0",
    });
  });

  it("uses the container port behind Docker port mapping on non-Linux hosts", () => {
    expect(analyticsDockerRuntimeNetwork("darwin", 54328, "host.docker.internal")).toEqual({
      listenPort: 4000,
      nodeHost: "0.0.0.0",
    });
  });
});

describe("makePostgresService (dockerAccessible)", () => {
  it("creates per-run pg_hba.conf instead of mutating shared cache", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "stack-postgres-service-"));
    const def = makePostgresService({
      binPath: POSTGRES_BIN_PATH,
      dataDir: path.join(tempDir, "data"),
      port: DB_PORT,
      dockerAccessible: true,
      cleanupDataDirOnExit: true,
    });
    const customHbaPath = `${path.join(tempDir, "data")}_pg_hba_docker.conf`;

    try {
      expect(def.name).toBe("postgres");
      expect(def.command).toBe("bash");
      expect(def.args).toEqual([
        `${POSTGRES_BIN_PATH}/share/supabase-cli/bin/supabase-postgres-init.sh`,
        "-p",
        "54322",
        "-c",
        "wal_level=logical",
        "-c",
        "max_wal_senders=5",
        "-c",
        "max_replication_slots=5",
        "-c",
        "listen_addresses=*",
        "-c",
        `hba_file=${customHbaPath}`,
      ]);
      expect(readFileSync(customHbaPath, "utf8")).toContain("0.0.0.0/0");
      expect(def.supervision).toEqual({
        orphanCleanup: [
          { _tag: "RemovePath", path: path.join(tempDir, "data") },
          { _tag: "RemovePath", path: customHbaPath, recursive: false },
        ],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(customHbaPath, { force: true });
    }
  });
});

describe("makePostgresServiceDocker", () => {
  it("creates a docker-based postgres ServiceDef", () => {
    const def = makePostgresServiceDocker({
      image: dockerImageForService("postgres", DEFAULT_VERSIONS.postgres),
      dataDir: "/tmp/supabase/data",
      port: DB_PORT,
      networkArgs: [...LINUX_HOST_GATEWAY_ARGS, "-p", `${DB_PORT}:${DB_PORT}`],
      jwtSecret: "test-jwt-secret-with-at-least-32-characters",
      jwtExpiry: 3600,
      apiPort: API_PORT,
    });

    expect(def.name).toBe("postgres");
    expect(def.command).toBe("docker");
    expect(def.args).toContain("run");
    expect(def.args).toContain("--rm");
    expect(def.args).toContain(`supabase-postgres-${API_PORT}`);
    expect(def.args).toContain("host.docker.internal:host-gateway");
    expect(def.args).toContain(`${DB_PORT}:${DB_PORT}`);
    expect(def.args).toContain(dockerImageForService("postgres", DEFAULT_VERSIONS.postgres));
    expect(def.args).toContain("/tmp/supabase/data:/var/lib/postgresql/data");
    // Verify port is passed to postgres inside the container
    expect(def.args?.[def.args.length - 1]).toContain(`-p ${DB_PORT}`);
    // Health check uses docker exec + pg_isready inside the container (host has no postgres tools)
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Exec",
      command: "docker",
      args: [
        "exec",
        `supabase-postgres-${API_PORT}`,
        "pg_isready",
        "-p",
        "54322",
        "-U",
        "postgres",
      ],
    });
    expect(def.dependencies).toBeUndefined();
    expect(def.restart).toBe("unless-stopped");
    expect(def.supervision).toEqual({
      orphanCleanup: [{ _tag: "DockerRemove", containerName: `supabase-postgres-${API_PORT}` }],
    });
  });

  it("bootstraps auxiliary databases and schemas used by docker-backed services", () => {
    const def = makePostgresServiceDocker({
      image: dockerImageForService("postgres", DEFAULT_VERSIONS.postgres),
      dataDir: "/tmp/supabase/data",
      port: DB_PORT,
      networkArgs: [...LINUX_HOST_GATEWAY_ARGS, "-p", `${DB_PORT}:${DB_PORT}`],
      jwtSecret: "test-jwt-secret-with-at-least-32-characters",
      jwtExpiry: 3600,
      apiPort: API_PORT,
    });

    const script = def.args?.[def.args.length - 1] as string;
    expect(script).toContain("CREATE DATABASE _supabase WITH OWNER postgres");
    expect(script).toContain(
      "WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '_supabase')",
    );
    expect(script).toContain("\\connect _supabase");
    expect(script).toContain("create schema if not exists _analytics;");
    expect(script).toContain("create schema if not exists _supavisor;");
  });
});

describe("makePostgrestService", () => {
  it("creates a postgrest ServiceDef depending on healthy postgres", () => {
    const def = makePostgrestService({
      binPath: POSTGREST_BIN_PATH,
      dbPort: DB_PORT,
      port: API_PORT,
      schemas: ["public", "storage"],
      extraSearchPath: ["public", "extensions"],
      maxRows: 1000,
      jwtSecret: JWT_SECRET,
    });

    expect(def.name).toBe("postgrest");
    expect(def.command).toBe(`${POSTGREST_BIN_PATH}/postgrest`);
    expect(def.env?.PGRST_DB_URI).toBe(
      `postgresql://authenticator:postgres@127.0.0.1:${DB_PORT}/postgres`,
    );
    expect(def.env?.PGRST_DB_SCHEMAS).toBe("public,storage");
    expect(def.env?.PGRST_SERVER_PORT).toBe("54321");
    expect(def.env?.PGRST_JWT_SECRET).toBe(JWT_SECRET);
    expect(def.dependencies).toEqual([{ service: "postgres-init", condition: "completed" }]);
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: API_PORT,
      path: "/",
      scheme: "http",
    });
    expect(def.supervision).toBeDefined();
  });
});

describe("makeAuthServiceNative", () => {
  it("creates a native auth ServiceDef depending on healthy postgres", () => {
    const def = makeAuthServiceNative({
      binPath: AUTH_BIN_PATH,
      dbPort: DB_PORT,
      authPort: 9999,
      siteUrl: "http://localhost:3000",
      jwtSecret: JWT_SECRET,
      jwtExpiry: 3600,
      externalUrl: `http://127.0.0.1:${API_PORT}`,
      dependencies: [{ service: "postgres-init", condition: "completed" }],
    });

    expect(def.name).toBe("auth");
    expect(def.command).toBe(`${AUTH_BIN_PATH}/auth`);
    expect(def.env?.GOTRUE_DB_DATABASE_URL).toContain(`127.0.0.1:${DB_PORT}`);
    expect(def.env?.GOTRUE_SITE_URL).toBe("http://localhost:3000");
    expect(def.env?.GOTRUE_JWT_SECRET).toBe(JWT_SECRET);
    expect(def.dependencies).toEqual([{ service: "postgres-init", condition: "completed" }]);
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 9999,
      path: "/health",
      scheme: "http",
    });
    expect(def.supervision).toBeDefined();
  });
});

describe("makeAuthServiceDocker", () => {
  it("creates a docker-based auth ServiceDef", () => {
    const def = makeAuthServiceDocker({
      image: dockerImageForService("auth", DEFAULT_VERSIONS.auth),
      dbPort: DB_PORT,
      authPort: 9999,
      siteUrl: "http://localhost:3000",
      jwtSecret: JWT_SECRET,
      jwtExpiry: 3600,
      externalUrl: `http://127.0.0.1:${API_PORT}`,
      dbHost: "127.0.0.1",
      networkArgs: [...LINUX_HOST_GATEWAY_ARGS, "-p", "9999:9999"],
      apiPort: API_PORT,
      dependencies: [{ service: "postgres", condition: "healthy" }],
    });

    expect(def.name).toBe("auth");
    expect(def.command).toBe("docker");
    expect(def.args).toContain("run");
    expect(def.args).toContain("--rm");
    expect(def.args).toContain(`supabase-auth-${API_PORT}`);
    expect(def.args).toContain("host.docker.internal:host-gateway");
    expect(def.args).toContain("9999:9999");
    expect(def.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    expect(def.supervision).toEqual({
      orphanCleanup: [{ _tag: "DockerRemove", containerName: `supabase-auth-${API_PORT}` }],
    });
  });
});

describe("makeEdgeRuntimeServiceDocker", () => {
  it("creates a docker-based edge runtime service with a generated bootstrap script", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "stack-edge-runtime-"));

    try {
      const def = makeEdgeRuntimeServiceDocker({
        image: dockerImageForService("edge-runtime", DEFAULT_VERSIONS["edge-runtime"]),
        apiPort: API_PORT,
        runtimeRoot: tempDir,
        port: 54340,
        inspectorPort: 54341,
        policy: "per_worker",
        env: { SUPABASE_INTERNAL_DEBUG: "true" },
        networkArgs: [...LINUX_HOST_GATEWAY_ARGS, "-p", "54340:54340", "-p", "54341:54341"],
        dependencies: [{ service: "postgres", condition: "healthy" }],
      });

      const bootstrapDir = path.join(tempDir, "edge-runtime");
      const bootstrapPath = path.join(bootstrapDir, "index.ts");
      expect(readFileSync(bootstrapPath, "utf8")).toContain("FUNCTIONS_NOT_CONFIGURED");
      expect(readFileSync(bootstrapPath, "utf8")).toContain("/_internal/health");
      expect(def.name).toBe("edge-runtime");
      expect(def.command).toBe("docker");
      expect(def.args).toContain(`supabase-edge-runtime-${API_PORT}`);
      expect(def.args).toContain("host.docker.internal:host-gateway");
      expect(def.args).toContain("54340:54340");
      expect(def.args).toContain(`--port=54340`);
      expect(def.args).toContain(`--policy=per_worker`);
      expect(def.args).toContain(`${bootstrapDir}:/workspace:ro`);
      expect(def.args).toContain("--ulimit");
      expect(def.args).toContain("nofile=65536:65536");
      expect(def.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
      expect(def.healthCheck?.probe).toEqual({
        _tag: "Http",
        host: "127.0.0.1",
        port: 54340,
        path: "/_internal/health",
        scheme: "http",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("makeEdgeRuntimeServiceNative", () => {
  it("creates a native edge runtime service with a generated bootstrap script", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "stack-edge-runtime-native-"));

    try {
      const def = makeEdgeRuntimeServiceNative({
        binPath: EDGE_RUNTIME_BIN_PATH,
        runtimeRoot: tempDir,
        port: 54340,
        inspectorPort: 54341,
        policy: "per_worker",
        env: { SUPABASE_INTERNAL_DEBUG: "true" },
        dependencies: [{ service: "postgres-init", condition: "completed" }],
      });

      const bootstrapPath = path.join(tempDir, "edge-runtime", "index.ts");
      expect(readFileSync(bootstrapPath, "utf8")).toContain("FUNCTIONS_NOT_CONFIGURED");
      expect(readFileSync(bootstrapPath, "utf8")).toContain("/_internal/health");
      expect(def.name).toBe("edge-runtime");
      expect(def.command).toBe(`${EDGE_RUNTIME_BIN_PATH}/bin/edge-runtime`);
      expect(def.args).toContain("start");
      expect(def.args).toContain(`--main-service=${path.join(tempDir, "edge-runtime")}`);
      expect(def.args).toContain(`--port=54340`);
      expect(def.args).toContain(`--policy=per_worker`);
      expect(def.env?.EDGE_RUNTIME_INSPECTOR_PORT).toBe("54341");
      expect(def.dependencies).toEqual([{ service: "postgres-init", condition: "completed" }]);
      expect(def.healthCheck?.probe).toEqual({
        _tag: "Http",
        host: "127.0.0.1",
        port: 54340,
        path: "/_internal/health",
        scheme: "http",
      });
      expect(def.supervision).toEqual({});
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("makePostgresInitService", () => {
  it("creates a one-shot postgres-init ServiceDef", () => {
    const def = makePostgresInitService({
      postgresDir: POSTGRES_BIN_PATH,
      dbPort: DB_PORT,
      autoExposeNewTables: true,
    });

    expect(def.name).toBe("postgres-init");
    expect(def.command).toBe("bash");
    expect(def.args?.[0]).toBe("-c");
    expect(def.restart).toBe("no");
    expect(def.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    expect(def.healthCheck).toBeUndefined();
    expect(def.env?.DYLD_LIBRARY_PATH).toBe(`${POSTGRES_BIN_PATH}/lib`);
    expect(def.env?.LD_LIBRARY_PATH).toBe(`${POSTGRES_BIN_PATH}/lib`);
    expect(def.supervision).toBeDefined();
  });

  it("does not use set -e (matches Go template approach)", () => {
    const def = makePostgresInitService({
      postgresDir: POSTGRES_BIN_PATH,
      dbPort: DB_PORT,
      autoExposeNewTables: true,
    });
    const script = def.args?.[1] as string;
    expect(script).not.toContain("set -e");
  });

  it("includes idempotency check for authenticator role", () => {
    const def = makePostgresInitService({
      postgresDir: "/cache/postgres/17/darwin-arm64",
      dbPort: DB_PORT,
      autoExposeNewTables: true,
    });
    const script = def.args?.[1] as string;
    expect(script).toContain("authenticator");
    expect(script).toContain("already initialized");
  });

  it("backfills auxiliary service schemas and internal databases", () => {
    const def = makePostgresInitService({
      postgresDir: "/cache/postgres/17/darwin-arm64",
      dbPort: DB_PORT,
      autoExposeNewTables: true,
    });
    const script = def.args?.[1] as string;

    expect(script).toContain("CREATE SCHEMA IF NOT EXISTS _realtime");
    expect(script).toContain("SELECT 1 FROM pg_database WHERE datname = '_supabase'");
    expect(script).toContain("CREATE DATABASE _supabase WITH OWNER postgres");
    expect(script).toContain("CREATE SCHEMA IF NOT EXISTS _analytics");
    expect(script).toContain("CREATE SCHEMA IF NOT EXISTS _supavisor");
  });

  it("batches SQL files via chained -f flags instead of shelling out to migrate.sh", () => {
    const def = makePostgresInitService({
      postgresDir: "/cache/postgres/17/darwin-arm64",
      dbPort: DB_PORT,
      autoExposeNewTables: true,
    });
    const script = def.args?.[1] as string;
    expect(script).not.toMatch(/sh .+migrate\.sh/);
    expect(script).toContain("-f $sql");
    expect(script).toContain("init-scripts/*.sql");
    expect(script).toContain("migrations/*.sql");
  });

  it("does not revoke default Data API privileges when autoExposeNewTables is true", () => {
    const def = makePostgresInitService({
      postgresDir: POSTGRES_BIN_PATH,
      dbPort: DB_PORT,
      autoExposeNewTables: true,
    });
    const script = def.args?.[1] as string;
    expect(script).not.toContain("alter default privileges");
    expect(script).not.toContain("revoke select, insert, update, delete on tables");
  });

  it("revokes default Data API privileges on `public` when autoExposeNewTables is false", () => {
    const def = makePostgresInitService({
      postgresDir: POSTGRES_BIN_PATH,
      dbPort: DB_PORT,
      autoExposeNewTables: false,
    });
    const script = def.args?.[1] as string;
    expect(script).toContain(REVOKE_DEFAULT_DATA_API_PRIVILEGES_SQL);
    expect(script).toContain(
      "revoke select, insert, update, delete on tables from anon, authenticated, service_role",
    );
    expect(script).toContain(
      "revoke usage, select on sequences from anon, authenticated, service_role",
    );
    expect(script).toContain("revoke execute on functions from anon, authenticated, service_role");
  });
});

describe("docker-backed auxiliary services", () => {
  it("uses a host HTTP readiness probe for mailpit", () => {
    const def = makeMailpitServiceDocker({
      image: dockerImageForService("mailpit", DEFAULT_VERSIONS.mailpit),
      apiPort: API_PORT,
      webPort: 54323,
      smtpPort: 54324,
      pop3Port: 54325,
      networkArgs: [
        ...LINUX_HOST_GATEWAY_ARGS,
        "-p",
        "54323:54323",
        "-p",
        "54324:54324",
        "-p",
        "54325:54325",
      ],
    });

    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54323,
      path: "/readyz",
      scheme: "http",
    });
  });

  it("uses a host HTTP health probe for imgproxy", () => {
    const def = makeImgproxyServiceDocker({
      image: dockerImageForService("imgproxy", DEFAULT_VERSIONS.imgproxy),
      apiPort: API_PORT,
      port: 54326,
      dataDir: "/tmp/supabase/storage",
      networkArgs: [...LINUX_HOST_GATEWAY_ARGS, "-p", "54326:54326"],
      dependencies: [{ service: "storage", condition: "healthy" }],
    });

    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54326,
      path: "/health",
      scheme: "http",
    });
    expect(def.args).toContain("/tmp/supabase/storage:/var/lib/storage");
  });

  it("uses docker exec for vector health because its admin port is not published", () => {
    const def = makeVectorServiceDocker({
      image: dockerImageForService("vector", DEFAULT_VERSIONS.vector),
      apiPort: API_PORT,
      serviceHost: "127.0.0.1",
      analyticsPort: 54327,
      analyticsApiKey: "test-api-key",
      networkArgs: [],
      dependencies: [{ service: "analytics", condition: "healthy" }],
    });

    expect(def.healthCheck?.probe).toEqual({
      _tag: "Exec",
      command: "docker",
      args: [
        "exec",
        `supabase-vector-${API_PORT}`,
        "sh",
        "-ec",
        "wget -q -O /dev/null http://127.0.0.1:9001/health",
      ],
    });
  });

  it("binds analytics on all interfaces so published ports and proxy health checks work", () => {
    const def = makeAnalyticsServiceDocker({
      image: dockerImageForService("analytics", DEFAULT_VERSIONS.analytics),
      apiPort: API_PORT,
      hostPort: 54328,
      listenPort: 4000,
      nodeHost: "0.0.0.0",
      dbHost: "127.0.0.1",
      dbPort: DB_PORT,
      apiKey: "test-api-key",
      backend: "postgres",
      networkArgs: ["-p", "54328:4000"],
      dependencies: [{ service: "postgres", condition: "healthy" }],
    });

    const args = def.args ?? [];
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54328,
      path: "/health",
      scheme: "http",
    });
    expect(def.healthCheck?.initialDelaySeconds).toBe(10);
    expect(args).toContain("PORT=4000");
    expect(args).toContain("PHX_HTTP_PORT=4000");
    expect(args).toContain("54328:4000");
    expect(args).toContain("LOGFLARE_NODE_HOST=0.0.0.0");
  });

  it("keeps analytics on its container port when Linux uses bridge networking", () => {
    const def = makeAnalyticsServiceDocker({
      image: dockerImageForService("analytics", DEFAULT_VERSIONS.analytics),
      apiPort: API_PORT,
      hostPort: 54328,
      listenPort: 4000,
      nodeHost: "0.0.0.0",
      dbHost: "host.docker.internal",
      dbPort: DB_PORT,
      apiKey: "test-api-key",
      backend: "postgres",
      networkArgs: [...LINUX_HOST_GATEWAY_ARGS, "-p", "54328:4000"],
      dependencies: [{ service: "postgres", condition: "healthy" }],
    });

    expect(def.args).toContain("PORT=4000");
    expect(def.args).toContain("PHX_HTTP_PORT=4000");
    expect(def.args).toContain("LOGFLARE_NODE_HOST=0.0.0.0");
    expect(def.args).toContain("host.docker.internal:host-gateway");
    expect(def.args).toContain("54328:4000");
  });

  it("keeps pooler container ports fixed and maps only the selected proxy port outward", () => {
    const def = makePoolerServiceDocker({
      image: dockerImageForService("pooler", DEFAULT_VERSIONS.pooler),
      apiPort: API_PORT,
      hostAdminPort: 54329,
      dbHost: "127.0.0.1",
      dbPort: DB_PORT,
      poolMode: "transaction",
      defaultPoolSize: 20,
      maxClientConn: 100,
      jwtSecret: JWT_SECRET,
      tenantId: "pooler-dev",
      encryptionKey: "12345678901234567890123456789012",
      secretKeyBase: "1234567890123456789012345678901234567890123456789012345678901234",
      networkArgs: [
        "-p",
        `54329:${poolerContainerPorts.admin}`,
        "-p",
        `54330:${poolerContainerPorts.transaction}`,
      ],
      dependencies: [{ service: "postgres", condition: "healthy" }],
    });

    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54329,
      path: "/api/health",
      scheme: "http",
    });
    expect(def.args).toContain(`PORT=${poolerContainerPorts.admin}`);
    expect(def.args).toContain(`PROXY_PORT_SESSION=${poolerContainerPorts.session}`);
    expect(def.args).toContain(`PROXY_PORT_TRANSACTION=${poolerContainerPorts.transaction}`);
    expect(def.args).toContain(`54329:${poolerContainerPorts.admin}`);
    expect(def.args).toContain(`54330:${poolerContainerPorts.transaction}`);
  });
});
