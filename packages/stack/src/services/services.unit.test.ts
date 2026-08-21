import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Predicate } from "effect";
import { analyticsDockerRuntimeNetwork, makeAnalyticsServiceDocker } from "./analytics.ts";
import { makeAuthServiceNative, makeAuthServiceDocker } from "./auth.ts";
import { makeEdgeRuntimeServiceDocker } from "./edge-runtime.ts";
import { edgeRuntimeNofileUlimit } from "./nofile-limit.ts";
import { makeImgproxyServiceDocker } from "./imgproxy.ts";
import { makeMailpitServiceDocker } from "./mailpit.ts";
import { makePgmetaServiceDocker } from "./pgmeta.ts";
import { makePostgresInitService } from "./postgres-init.ts";
import { makePostgresService, makePostgresServiceDocker } from "./postgres.ts";
import { makePostgrestService, makePostgrestServiceDocker } from "./postgrest.ts";
import { makeRealtimeServiceDocker } from "./realtime.ts";
import { makePoolerServiceDocker, poolerContainerPorts } from "./pooler.ts";
import {
  LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
  LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
  makeStorageServiceDocker,
} from "./storage.ts";
import { makeStudioServiceDocker } from "./studio.ts";
import { makeVectorServiceDocker } from "./vector.ts";
import { stackIdentity, type StackIdentity } from "../StackIdentity.ts";
import { DEFAULT_VERSIONS, dockerImageForService } from "../versions.ts";

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const DB_PORT = 54322;
const API_PORT = 54321;
// A stack started without an identity of its own: its Docker names stay derived
// from its api port.
const EPHEMERAL_IDENTITY: StackIdentity = stackIdentity({ apiPort: API_PORT });
const POSTGRES_BIN_PATH = `/cache/postgres/${DEFAULT_VERSIONS.postgres}/darwin-arm64`;
const POSTGREST_BIN_PATH = `/cache/postgrest/${DEFAULT_VERSIONS.postgrest}/macos-aarch64`;
const AUTH_BIN_PATH = `/cache/auth/${DEFAULT_VERSIONS.auth}/arm64`;
describe("makePostgresService", () => {
  it("creates a postgres ServiceDef with correct defaults", () => {
    const def = makePostgresService({
      binPath: POSTGRES_BIN_PATH,
      dataDir: "/tmp/supabase/data",
      port: DB_PORT,
      dependencies: [],
    });

    expect(def.name).toBe("postgres");
    expect(def.command).toBe(
      `${POSTGRES_BIN_PATH}/share/supabase-cli/bin/supabase-postgres-init.sh`,
    );
    expect(def.args).toContain("listen_addresses=127.0.0.1");
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
    expect(def.dependencies).toEqual([]);
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

describe("makeStudioServiceDocker", () => {
  it("injects legacy keys, opaque keys, and S3 protocol credentials", () => {
    const def = makeStudioServiceDocker({
      runtime: "docker",
      image: dockerImageForService("studio", DEFAULT_VERSIONS.studio),
      identity: EPHEMERAL_IDENTITY,
      port: 54323,
      apiUrl: "http://host.docker.internal:54321",
      publicApiUrl: "http://127.0.0.1:54321",
      pgmetaUrl: "http://host.docker.internal:54322",
      publishableKey: "sb_publishable_test",
      secretKey: "sb_secret_test",
      s3ProtocolAccessKeyId: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
      s3ProtocolAccessKeySecret: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
      jwtSecret: JWT_SECRET,
      analyticsEnabled: true,
      analyticsBackend: "postgres",
      analyticsUrl: "http://host.docker.internal:54327",
      analyticsApiKey: "test-api-key",
      platformOs: "darwin",
      dependencies: [{ service: "pgmeta", condition: "healthy" }],
    });

    expect(def.args).toContain("SUPABASE_ANON_KEY=sb_publishable_test");
    expect(def.args).toContain("SUPABASE_SERVICE_KEY=sb_secret_test");
    expect(def.args).toContain("SUPABASE_PUBLISHABLE_KEY=sb_publishable_test");
    expect(def.args).toContain("SUPABASE_SECRET_KEY=sb_secret_test");
    expect(def.args).toContain(`S3_PROTOCOL_ACCESS_KEY_ID=${LOCAL_S3_PROTOCOL_ACCESS_KEY_ID}`);
    expect(def.args).toContain(
      `S3_PROTOCOL_ACCESS_KEY_SECRET=${LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET}`,
    );
  });
});

describe("makePostgresServiceDocker", () => {
  it("creates a docker-based postgres ServiceDef", () => {
    const def = makePostgresServiceDocker({
      runtime: "docker",
      image: dockerImageForService("postgres", DEFAULT_VERSIONS.postgres),
      dataDir: "/tmp/supabase/data",
      port: DB_PORT,
      platformOs: "linux",
      identity: EPHEMERAL_IDENTITY,
      dependencies: [],
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
    expect(def.args).toContain("/usr/bin/sh");
    expect(def.args?.at(-2)).toBe("-c");
    // The Linux-compatible health gate distinguishes the final server from
    // the image's temporary initialization server.
    expect(def.healthCheck?.probe).toEqual(
      expect.objectContaining({ _tag: "Exec", command: "docker" }),
    );
    expect(
      Predicate.isTagged(def.healthCheck?.probe, "Exec") && def.healthCheck.probe.args.join(" "),
    ).toContain("/proc/1/comm");
    expect(def.dependencies).toEqual([]);
    expect(def.restart).toBe("unless-stopped");
    expect(def.supervision?.orphanCleanup).toBeDefined();
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
      dependencies: [{ service: "postgres-init", condition: "completed" }],
    });

    expect(def.name).toBe("postgrest");
    expect(def.command).toBe(`${POSTGREST_BIN_PATH}/bin/postgrest`);
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

  it("creates a docker definition with caller-supplied topology and derived identity", () => {
    const dependencies = [{ service: "postgres", condition: "healthy" }] as const;
    const def = makePostgrestServiceDocker({
      runtime: "docker",
      image: dockerImageForService("postgrest", DEFAULT_VERSIONS.postgrest),
      identity: EPHEMERAL_IDENTITY,
      dbHost: "host.docker.internal",
      dbPort: DB_PORT,
      port: 54323,
      adminPort: 54324,
      schemas: ["public", "storage"],
      extraSearchPath: ["public", "extensions"],
      maxRows: 1000,
      jwtSecret: JWT_SECRET,
      platformOs: "linux",
      dependencies,
    });

    expect(def.command).toBe("docker");
    expect(def.args).toContain(`supabase-postgrest-${API_PORT}`);
    expect(def.args).toContain("host.docker.internal:host-gateway");
    expect(def.args).toContain("54323:54323");
    expect(def.args).toContain("54324:54324");
    expect(def.args).toContain("PGRST_ADMIN_SERVER_PORT=54324");
    expect(def.dependencies).toEqual(dependencies);
    expect(def.supervision?.orphanCleanup).toContainEqual({
      _tag: "RunCommand",
      executable: "docker",
      args: ["rm", "-f", `supabase-postgrest-${API_PORT}`],
      timeoutMs: 5_000,
    });
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
    expect(def.command).toBe(`${AUTH_BIN_PATH}/bin/auth`);
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
      runtime: "docker",
      image: dockerImageForService("auth", DEFAULT_VERSIONS.auth),
      dbPort: DB_PORT,
      authPort: 9999,
      siteUrl: "http://localhost:3000",
      jwtSecret: JWT_SECRET,
      jwtExpiry: 3600,
      externalUrl: `http://127.0.0.1:${API_PORT}`,
      dbHost: "127.0.0.1",
      platformOs: "linux",
      identity: EPHEMERAL_IDENTITY,
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
      orphanCleanup: [
        {
          _tag: "RunCommand",
          executable: "docker",
          args: ["rm", "-f", `supabase-auth-${API_PORT}`],
          timeoutMs: 5_000,
        },
      ],
    });
  });
});

describe("makeEdgeRuntimeServiceDocker", () => {
  it("creates a docker-based edge runtime service with a generated bootstrap script", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "stack-edge-runtime-"));

    try {
      const def = makeEdgeRuntimeServiceDocker({
        runtime: "docker",
        image: dockerImageForService("edge-runtime", DEFAULT_VERSIONS["edge-runtime"]),
        identity: EPHEMERAL_IDENTITY,
        runtimeRoot: tempDir,
        bootstrapDir: path.join(tempDir, "edge-runtime"),
        port: 54340,
        inspectorPort: 54341,
        policy: "per_worker",
        env: { SUPABASE_INTERNAL_DEBUG: "true" },
        platformOs: "linux",
        dependencies: [{ service: "postgres", condition: "healthy" }],
      });

      const bootstrapDir = path.join(tempDir, "edge-runtime");
      expect(def.name).toBe("edge-runtime");
      expect(def.command).toBe("docker");
      expect(def.args).toContain(`supabase-edge-runtime-${API_PORT}`);
      expect(def.args).toContain("host.docker.internal:host-gateway");
      expect(def.args).toContain("54340:54340");
      expect(def.args).toContain(`--port=54340`);
      expect(def.args).toContain(`--policy=per_worker`);
      expect(def.args).toContain(`${bootstrapDir}:/workspace:ro`);
      expect(def.args).toContain("--ulimit");
      expect(def.args).toContain(edgeRuntimeNofileUlimit("linux").arg);
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

describe("makePostgresInitService", () => {
  it("creates a one-shot postgres-init ServiceDef", () => {
    const def = makePostgresInitService({
      postgresDir: POSTGRES_BIN_PATH,
      dbPort: DB_PORT,
      autoExposeNewTables: true,
      dependencies: [{ service: "postgres", condition: "healthy" }],
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
});

describe("docker-backed auxiliary services", () => {
  it("defines realtime command, topology, environment, and readiness locally", () => {
    const dependencies = [{ service: "postgres", condition: "healthy" }] as const;
    const def = makeRealtimeServiceDocker({
      runtime: "docker",
      image: dockerImageForService("realtime", DEFAULT_VERSIONS.realtime),
      identity: EPHEMERAL_IDENTITY,
      port: 54330,
      dbHost: "host.docker.internal",
      dbPort: DB_PORT,
      jwtSecret: JWT_SECRET,
      jwtJwks: "test-jwks",
      tenantId: "realtime-dev",
      encryptionKey: "supabaserealtime",
      secretKeyBase: "test-secret-key-base",
      maxHeaderLength: 4096,
      platformOs: "linux",
      dependencies,
    });

    expect(def.args).toContain(`supabase-realtime-${API_PORT}`);
    expect(def.args).toContain("54330:54330");
    expect(def.args).toContain("DB_HOST=host.docker.internal");
    expect(def.dependencies).toEqual(dependencies);
    expect(def.healthCheck?.probe).toEqual(
      expect.objectContaining({ _tag: "Exec", command: "curl" }),
    );
  });

  it("defines storage mounts, cleanup, topology, and readiness locally", () => {
    const dependencies = [{ service: "postgres-init", condition: "completed" }] as const;
    const def = makeStorageServiceDocker({
      runtime: "docker",
      image: dockerImageForService("storage", DEFAULT_VERSIONS.storage),
      identity: EPHEMERAL_IDENTITY,
      port: 54331,
      dbHost: "host.docker.internal",
      dbPort: DB_PORT,
      dataDir: "/tmp/supabase/storage",
      anonKey: "anon-key",
      serviceKey: "service-key",
      jwtSecret: JWT_SECRET,
      jwtJwks: "test-jwks",
      fileSizeLimit: "50MiB",
      enableImageTransformation: true,
      imgproxyUrl: "http://host.docker.internal:54332",
      s3ProtocolEnabled: true,
      cleanupDataDirOnExit: true,
      platformOs: "linux",
      dependencies,
    });

    expect(def.args).toContain(`supabase-storage-${API_PORT}`);
    expect(def.args).toContain("/tmp/supabase/storage:/var/lib/storage");
    expect(def.args).toContain("54331:54331");
    expect(def.dependencies).toEqual(dependencies);
    expect(def.healthCheck?.probe).toEqual(
      expect.objectContaining({ _tag: "Http", port: 54331, path: "/status" }),
    );
    expect(def.supervision?.orphanCleanup).toContainEqual({
      _tag: "RemovePath",
      path: "/tmp/supabase/storage",
      recursive: true,
    });
  });

  it("defines postgres metadata command, topology, environment, and readiness locally", () => {
    const dependencies = [{ service: "postgres", condition: "healthy" }] as const;
    const def = makePgmetaServiceDocker({
      runtime: "docker",
      image: dockerImageForService("pgmeta", DEFAULT_VERSIONS.pgmeta),
      identity: EPHEMERAL_IDENTITY,
      port: 54336,
      dbHost: "host.docker.internal",
      dbPort: DB_PORT,
      platformOs: "linux",
      dependencies,
    });

    expect(def.args).toContain(`supabase-pgmeta-${API_PORT}`);
    expect(def.args).toContain("54336:54336");
    expect(def.args).toContain("PG_META_DB_HOST=host.docker.internal");
    expect(def.dependencies).toEqual(dependencies);
    expect(def.healthCheck?.probe).toEqual(
      expect.objectContaining({ _tag: "Http", port: 54336, path: "/health" }),
    );
  });

  it("uses a host HTTP readiness probe for mailpit", () => {
    const def = makeMailpitServiceDocker({
      runtime: "docker",
      image: dockerImageForService("mailpit", DEFAULT_VERSIONS.mailpit),
      identity: EPHEMERAL_IDENTITY,
      webPort: 54323,
      smtpPort: 54324,
      pop3Port: 54325,
      platformOs: "linux",
      dependencies: [],
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
      runtime: "docker",
      image: dockerImageForService("imgproxy", DEFAULT_VERSIONS.imgproxy),
      identity: EPHEMERAL_IDENTITY,
      port: 54326,
      dataDir: "/tmp/supabase/storage",
      platformOs: "linux",
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
      runtime: "docker",
      image: dockerImageForService("vector", DEFAULT_VERSIONS.vector),
      identity: EPHEMERAL_IDENTITY,
      serviceHost: "127.0.0.1",
      analyticsPort: 54327,
      analyticsApiKey: "test-api-key",
      platformOs: "darwin",
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
      runtime: "docker",
      image: dockerImageForService("analytics", DEFAULT_VERSIONS.analytics),
      identity: EPHEMERAL_IDENTITY,
      hostPort: 54328,
      platformOs: "darwin",
      dbHost: "127.0.0.1",
      dbPort: DB_PORT,
      apiKey: "test-api-key",
      backend: "postgres",
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
      runtime: "docker",
      image: dockerImageForService("analytics", DEFAULT_VERSIONS.analytics),
      identity: EPHEMERAL_IDENTITY,
      hostPort: 54328,
      platformOs: "linux",
      dbHost: "host.docker.internal",
      dbPort: DB_PORT,
      apiKey: "test-api-key",
      backend: "postgres",
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
      runtime: "docker",
      image: dockerImageForService("pooler", DEFAULT_VERSIONS.pooler),
      identity: EPHEMERAL_IDENTITY,
      hostAdminPort: 54329,
      hostPort: 54330,
      platformOs: "linux",
      dbHost: "127.0.0.1",
      dbPort: DB_PORT,
      poolMode: "transaction",
      defaultPoolSize: 20,
      maxClientConn: 100,
      jwtSecret: JWT_SECRET,
      tenantId: "pooler-dev",
      encryptionKey: "12345678901234567890123456789012",
      secretKeyBase: "1234567890123456789012345678901234567890123456789012345678901234",
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
