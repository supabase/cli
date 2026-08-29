// oxlint-disable effecttsgo/node-builtin-import -- Service tests use native filesystem/path fixtures to validate service wiring.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Predicate } from "effect";
import { analyticsDockerRuntimeNetwork, makeAnalyticsServiceDocker } from "./analytics.ts";
import { makeAuthServiceNative, makeAuthServiceDocker } from "./auth.ts";
import { makeEdgeRuntimeServiceDocker, makeEdgeRuntimeServiceNative } from "./edge-runtime.ts";
import { edgeRuntimeNofileUlimit } from "./nofile-limit.ts";
import { makeImgproxyServiceDocker, makeImgproxyServiceNative } from "./imgproxy.ts";
import { makeMailpitServiceDocker, makeMailpitServiceNative } from "./mailpit.ts";
import { makePgmetaServiceDocker, makePgmetaServiceNative } from "./pgmeta.ts";
import { makePostgresInitService, makePostgresInitServiceDocker } from "./postgres-init.ts";
import { makePostgresService, makePostgresServiceDocker } from "./postgres.ts";
import { makePostgrestService, makePostgrestServiceDocker } from "./postgrest.ts";
import { makeRealtimeServiceDocker, makeRealtimeServicesNative } from "./realtime.ts";
import {
  makePoolerServiceDocker,
  makePoolerServicesNative,
  poolerContainerPorts,
} from "./pooler.ts";
import { dockerRunService } from "./service-utils.ts";
import {
  LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
  LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
  makeStorageServiceNative,
  makeStorageServiceDocker,
} from "./storage.ts";
import { makeStudioServiceDocker, makeStudioServiceNative } from "./studio.ts";
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

describe("dockerRunService environment transport", () => {
  it("keeps secret values in the child environment instead of argv", () => {
    const env = {
      PASSWORD: "postgres-password",
      JWT_SECRET,
    };
    const def = dockerRunService({
      runtime: "docker",
      name: "auth",
      identity: EPHEMERAL_IDENTITY,
      image: "supabase/auth:test",
      env,
      dependencies: [],
    });

    expect(def.env).toEqual(env);
    const args = def.args ?? [];
    for (const [key, value] of Object.entries(env)) {
      const index = args.indexOf(key);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(args[index - 1]).toBe("-e");
      expect(args[index + 1]).not.toBe(value);
    }
    expect(args.every((arg) => !Object.values(env).some((value) => arg.includes(value)))).toBe(
      true,
    );
  });
});

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

    expect(def.env).toMatchObject({
      SUPABASE_ANON_KEY: "sb_publishable_test",
      SUPABASE_SERVICE_KEY: "sb_secret_test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      S3_PROTOCOL_ACCESS_KEY_ID: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
      S3_PROTOCOL_ACCESS_KEY_SECRET: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
      HOSTNAME: "0.0.0.0",
    });
    expect(def.args).not.toContain("sb_secret_test");
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

  it("prepares the Linux postgres socket directory before dropping privileges", () => {
    const def = makePostgresServiceDocker({
      runtime: "docker",
      image: dockerImageForService("postgres", DEFAULT_VERSIONS.postgres),
      dataDir: "/tmp/supabase/data",
      port: DB_PORT,
      platformOs: "linux",
      identity: EPHEMERAL_IDENTITY,
      dependencies: [],
    });
    const command = def.args?.at(-1) ?? "";
    const mkdirIndex = command.indexOf("busybox mkdir -p /run/postgresql");
    const chownIndex = command.indexOf("busybox chown ", mkdirIndex);
    const chmodIndex = command.indexOf("busybox chmod 2775 /run/postgresql");
    const suIndex = command.indexOf("exec busybox su -s /usr/bin/sh supabase_cli");

    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(chownIndex).toBeGreaterThan(mkdirIndex);
    expect(chmodIndex).toBeGreaterThan(chownIndex);
    expect(suIndex).toBeGreaterThan(chmodIndex);
    expect(command.slice(mkdirIndex, chmodIndex)).toMatch(
      /busybox chown \d+:\d+ \/run\/postgresql/,
    );
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
    expect(def.env?.PGRST_ADMIN_SERVER_PORT).toBe("54324");
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

describe("native auxiliary service definitions", () => {
  it("starts Edge Runtime from the prepared wrapper and generated host paths", () => {
    const artifactRoot = "/cache/edge-runtime/v1.74.3/darwin-arm64";
    const runtimeRoot = "/tmp/stacks/project-a/runtime";
    const projectDir = "/tmp/stacks/project-a/project";
    const bootstrapDir = `${runtimeRoot}/edge-runtime`;
    const def = makeEdgeRuntimeServiceNative({
      binPath: artifactRoot,
      runtimeRoot,
      projectDir,
      bootstrapDir,
      port: 54340,
      inspectorPort: 54341,
      policy: "per_worker",
      env: { SUPABASE_INTERNAL_DEBUG: "true" },
      dependencies: [{ service: "postgres", condition: "healthy" }],
    });

    expect(def.command).toBe(`${artifactRoot}/bin/.edge-runtime-wrapped`);
    expect(def.posixResourceLimits).toEqual({ nofileSoft: 65536 });
    expect(def.args).toEqual([
      "start",
      `--main-service=${bootstrapDir}`,
      "--port=54340",
      "--policy=per_worker",
    ]);
    expect(def.cwd).toBe(projectDir);
    expect(def.env).toMatchObject({
      SUPABASE_INTERNAL_DEBUG: "true",
      FUNCTIONS_RUNTIME_CONFIG_PATH: `${runtimeRoot}/edge-runtime/functions-runtime-config.json`,
    });
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54340,
      path: "/_internal/health",
      scheme: "http",
    });
  });

  it("orchestrates Realtime migration, seed, and server through rooted host entrypoints", () => {
    const artifactRoot = "/cache/realtime/v2.129.1/linux-amd64";
    const dependencies = [{ service: "postgres", condition: "healthy" }] as const;
    const bundle = makeRealtimeServicesNative({
      binPath: artifactRoot,
      nodeName: "realtime_id_stack_a",
      releaseCookie: "supabase_stack_a_cookie",
      port: 54330,
      dbPort: DB_PORT,
      jwtSecret: JWT_SECRET,
      jwtJwks: "native-jwks",
      tenantId: "native-realtime",
      encryptionKey: "native-encryption-key",
      secretKeyBase: "native-secret-key-base",
      maxHeaderLength: 4096,
      dependencies,
    });

    expect(bundle.migrate).toMatchObject({
      name: "realtime-migrate",
      command: `${artifactRoot}/bin/migrate`,
      restart: "no",
      dependencies,
    });
    expect(bundle.seed).toMatchObject({
      name: "realtime-seed",
      command: `${artifactRoot}/bin/realtime`,
      args: ["eval", "Realtime.Release.seeds(Realtime.Repo)"],
      restart: "no",
      dependencies: [{ service: "realtime-migrate", condition: "completed" }],
    });
    expect(bundle.server).toMatchObject({
      name: "realtime",
      command: `${artifactRoot}/bin/server`,
      dependencies: [{ service: "realtime-seed", condition: "completed" }],
      restart: "unless-stopped",
    });
    expect(bundle.server.env).toMatchObject({
      PORT: "54330",
      DB_HOST: "127.0.0.1",
      DB_PORT: String(DB_PORT),
      API_JWT_SECRET: JWT_SECRET,
      API_JWT_JWKS: "native-jwks",
      SECRET_KEY_BASE: "native-secret-key-base",
      MAX_HEADER_LENGTH: "4096",
      NODE_NAME: "realtime_id_stack_a",
      NODE_IP: "127.0.0.1",
      RELEASE_NODE: "realtime_id_stack_a@127.0.0.1",
      RELEASE_COOKIE: "supabase_stack_a_cookie",
    });
    expect(bundle.server.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54330,
      path: "/api/ping",
      scheme: "http",
      headers: { Host: "native-realtime" },
    });
  });

  it("binds both native Pooler protocol ports with stack-unique distribution identity", () => {
    const artifactRoot = "/cache/pooler/v2.9.10/linux-amd64";
    const dependencies = [{ service: "postgres", condition: "healthy" }] as const;
    const bundle = makePoolerServicesNative({
      binPath: artifactRoot,
      runtimeRoot: "/tmp/stacks/project-a/runtime",
      adminPort: 54329,
      sessionPort: 54330,
      transactionPort: 54331,
      nodeName: "supavisor_id_stack_a",
      releaseCookie: "supabase_stack_a_cookie",
      dbPort: DB_PORT,
      poolMode: "transaction",
      defaultPoolSize: 20,
      maxClientConn: 100,
      jwtSecret: JWT_SECRET,
      tenantId: "native-pooler",
      encryptionKey: "native-encryption-key",
      secretKeyBase: "native-secret-key-base",
      dependencies,
    });

    expect(bundle.server.env).toMatchObject({
      PORT: "54329",
      PROXY_PORT_SESSION: "54330",
      PROXY_PORT_TRANSACTION: "54331",
      NODE_NAME: "supavisor_id_stack_a",
      NODE_IP: "127.0.0.1",
      RELEASE_NODE: "supavisor_id_stack_a@127.0.0.1",
      RELEASE_COOKIE: "supabase_stack_a_cookie",
    });
    expect(bundle.migrate.env).toMatchObject({
      NODE_NAME: "supavisor_id_stack_a",
      NODE_IP: "127.0.0.1",
      RELEASE_COOKIE: "supabase_stack_a_cookie",
    });
  });

  it("starts PgMeta from its published host launcher against loopback PostgreSQL", () => {
    const artifactRoot = "/cache/pgmeta/v0.98.0/linux-amd64";
    const dependencies = [{ service: "postgres", condition: "healthy" }] as const;
    const def = makePgmetaServiceNative({
      binPath: artifactRoot,
      port: 54336,
      dbPort: DB_PORT,
      dependencies,
    });

    expect(def.command).toBe(`${artifactRoot}/bin/pgmeta`);
    expect(def.args).toBeUndefined();
    expect(def.env).toMatchObject({
      PG_META_PORT: "54336",
      PG_META_DB_HOST: "127.0.0.1",
      PG_META_DB_PORT: String(DB_PORT),
    });
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54336,
      path: "/health",
      scheme: "http",
    });
  });

  it("starts Studio from its published host launcher with host URLs", () => {
    const artifactRoot = "/cache/studio/2026.08.17-sha-0c1da8f/darwin-arm64";
    const def = makeStudioServiceNative({
      binPath: artifactRoot,
      port: 54323,
      apiUrl: "http://127.0.0.1:54321",
      publicApiUrl: "http://127.0.0.1:54321",
      pgmetaUrl: "http://127.0.0.1:54336",
      publishableKey: "sb_publishable_native",
      secretKey: "sb_secret_native",
      s3ProtocolAccessKeyId: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
      s3ProtocolAccessKeySecret: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
      jwtSecret: JWT_SECRET,
      analyticsEnabled: true,
      analyticsBackend: "postgres",
      analyticsUrl: "http://127.0.0.1:54327",
      analyticsApiKey: "native-analytics-key",
      dependencies: [{ service: "pgmeta", condition: "healthy" }],
    });

    expect(def.command).toBe(`${artifactRoot}/bin/studio`);
    expect(def.args).toBeUndefined();
    expect(def.env).toMatchObject({
      PORT: "54323",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_PUBLIC_URL: "http://127.0.0.1:54321",
      STUDIO_PG_META_URL: "http://127.0.0.1:54336",
      LOGFLARE_URL: "http://127.0.0.1:54327",
      LOGFLARE_PRIVATE_ACCESS_TOKEN: "native-analytics-key",
      HOSTNAME: "127.0.0.1",
    });
  });

  it("binds Mailpit protocols on independent loopback ports and an owning data path", () => {
    const artifactRoot = "/cache/mailpit/v1.30.2/linux-amd64";
    const dataDir = "/tmp/stacks/project-a/data/mailpit";
    const def = makeMailpitServiceNative({
      binPath: artifactRoot,
      dataDir,
      webPort: 54323,
      smtpPort: 54324,
      pop3Port: 54325,
      dependencies: [],
    });

    expect(def.command).toBe(`${artifactRoot}/bin/mailpit`);
    expect(def.args).toBeUndefined();
    expect(def.env).toMatchObject({
      MP_UI_BIND_ADDR: "127.0.0.1:54323",
      MP_SMTP_BIND_ADDR: "127.0.0.1:54324",
      MP_POP3_BIND_ADDR: "127.0.0.1:54325",
      MP_SMTP_DISABLE_RDNS: "true",
      MP_DATABASE: `${dataDir}/mailpit.db`,
    });
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54323,
      path: "/readyz",
      scheme: "http",
    });
  });

  it("cleans up only auto-managed native Mailpit data after an orphaned supervisor", () => {
    const dataDir = "/tmp/stacks/project-a/data/mailpit";
    const managed = makeMailpitServiceNative({
      binPath: "/cache/mailpit/v1.30.2/linux-amd64",
      dataDir,
      webPort: 54323,
      smtpPort: 54324,
      pop3Port: 54325,
      cleanupDataDirOnExit: true,
      dependencies: [],
    });
    const explicit = makeMailpitServiceNative({
      binPath: "/cache/mailpit/v1.30.2/linux-amd64",
      dataDir,
      webPort: 54323,
      smtpPort: 54324,
      pop3Port: 54325,
      cleanupDataDirOnExit: false,
      dependencies: [],
    });

    expect(managed.supervision?.orphanCleanup).toEqual([
      { _tag: "RemovePath", path: dataDir, recursive: true },
    ]);
    expect(explicit.supervision?.orphanCleanup).toEqual([]);
  });

  it("couples native Storage and imgproxy on one owning data root", () => {
    const artifactRoot = "/cache/storage/v1.70.1/darwin-arm64";
    const imgproxyArtifactRoot = "/cache/imgproxy/v3.8.0/darwin-arm64";
    const dataDir = "/tmp/stacks/project-a/data/storage";
    const storageDependencies = [{ service: "postgres-init", condition: "completed" }] as const;
    const storage = makeStorageServiceNative({
      binPath: artifactRoot,
      port: 54331,
      dbPort: DB_PORT,
      dataDir,
      anonKey: "native-anon-key",
      serviceKey: "native-service-key",
      jwtSecret: JWT_SECRET,
      jwtJwks: "native-jwks",
      fileSizeLimit: "50MiB",
      enableImageTransformation: true,
      imgproxyUrl: "http://127.0.0.1:54332",
      s3ProtocolEnabled: true,
      cleanupDataDirOnExit: true,
      dependencies: storageDependencies,
    });
    const imgproxy = makeImgproxyServiceNative({
      binPath: imgproxyArtifactRoot,
      port: 54332,
      dependencies: [{ service: "storage", condition: "healthy" }],
    });

    expect(storage).toMatchObject({
      name: "storage",
      command: `${artifactRoot}/bin/storage`,
      dependencies: storageDependencies,
      restart: "unless-stopped",
      healthCheck: {
        probe: {
          _tag: "Http",
          host: "127.0.0.1",
          port: 54331,
          path: "/status",
          scheme: "http",
        },
      },
      supervision: {
        orphanCleanup: [{ _tag: "RemovePath", path: dataDir, recursive: true }],
      },
    });
    expect(storage.env).toMatchObject({
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: "54331",
      DATABASE_URL: `postgresql://supabase_storage_admin:postgres@127.0.0.1:${DB_PORT}/postgres`,
      FILE_STORAGE_BACKEND_PATH: dataDir,
      STORAGE_FILE_BACKEND_PATH: dataDir,
      ENABLE_IMAGE_TRANSFORMATION: "true",
      IMAGE_TRANSFORMATION_ENABLED: "true",
      IMGPROXY_URL: "http://127.0.0.1:54332",
      FILE_SIZE_LIMIT: "50MiB",
      S3_PROTOCOL_ENABLED: "true",
    });
    expect(imgproxy).toMatchObject({
      name: "imgproxy",
      command: `${imgproxyArtifactRoot}/bin/imgproxy`,
      dependencies: [{ service: "storage", condition: "healthy" }],
      restart: "unless-stopped",
      healthCheck: {
        probe: {
          _tag: "Http",
          host: "127.0.0.1",
          port: 54332,
          path: "/health",
          scheme: "http",
        },
      },
    });
    expect(imgproxy.env).toMatchObject({
      IMGPROXY_BIND: "127.0.0.1:54332",
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
      IMGPROXY_USE_ETAG: "/",
    });
    expect(imgproxy.env?.IMGPROXY_LOCAL_FILESYSTEM_ROOT).toBe("/");
    expect(imgproxy).not.toHaveProperty("supervision.orphanCleanup");
  });
});

describe("makePostgresInitService", () => {
  it("creates a one-shot postgres-init ServiceDef", () => {
    const def = makePostgresInitService({
      postgresDir: POSTGRES_BIN_PATH,
      dbPort: DB_PORT,
      jwtSecret: JWT_SECRET,
      jwtExpiry: 3600,
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
    expect(def.env?.JWT_SECRET).toBe(JWT_SECRET);
    expect(def.env?.JWT_EXP).toBe("3600");
    expect(def.supervision).toBeDefined();
  });

  it.each(["native", "docker"] as const)(
    "%s initialization revokes default Data API privileges only when auto-exposure is disabled",
    (mode) => {
      const commandFor = (autoExposeNewTables: boolean): string => {
        const common = {
          dbPort: DB_PORT,
          jwtSecret: JWT_SECRET,
          jwtExpiry: 3600,
          autoExposeNewTables,
          dependencies: [{ service: "postgres", condition: "healthy" }] as const,
        };
        const definition =
          mode === "native"
            ? makePostgresInitService({ ...common, postgresDir: POSTGRES_BIN_PATH })
            : makePostgresInitServiceDocker({
                ...common,
                runtime: "docker",
                jwtSecret: JWT_SECRET,
                jwtExpiry: 3600,
                identity: EPHEMERAL_IDENTITY,
              });
        return definition.args?.join("\n") ?? "";
      };

      expect(commandFor(true)).not.toContain(
        "alter default privileges for role postgres in schema public",
      );
      expect(commandFor(false)).toContain(
        "alter default privileges for role postgres in schema public",
      );
    },
  );
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
    expect(def.env?.DB_HOST).toBe("host.docker.internal");
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
    expect(def.env?.ENABLE_IMAGE_TRANSFORMATION).toBe("true");
    expect(def.env?.IMAGE_TRANSFORMATION_ENABLED).toBe("true");
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
    expect(def.env?.PG_META_DB_HOST).toBe("host.docker.internal");
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
    expect(def.env?.PORT).toBe("4000");
    expect(def.env?.PHX_HTTP_PORT).toBe("4000");
    expect(def.env?.PHX_HTTP_IP).toBe("0.0.0.0");
    expect(def.env?.LOGFLARE_NODE_HOST).toBe("0.0.0.0");
    expect(args).toContain("54328:4000");
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

    expect(def.env?.PORT).toBe("4000");
    expect(def.env?.PHX_HTTP_PORT).toBe("4000");
    expect(def.env?.PHX_HTTP_IP).toBe("0.0.0.0");
    expect(def.env?.LOGFLARE_NODE_HOST).toBe("0.0.0.0");
    expect(def.args).toContain("host.docker.internal:host-gateway");
    expect(def.args).toContain("54328:4000");
  });

  it("keeps pooler container ports fixed and maps both proxy ports outward", () => {
    const def = makePoolerServiceDocker({
      runtime: "docker",
      image: dockerImageForService("pooler", DEFAULT_VERSIONS.pooler),
      identity: EPHEMERAL_IDENTITY,
      hostAdminPort: 54329,
      hostSessionPort: 54330,
      hostTransactionPort: 54331,
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
    expect(def.env?.PORT).toBe(String(poolerContainerPorts.admin));
    expect(def.env?.PROXY_PORT_SESSION).toBe(String(poolerContainerPorts.session));
    expect(def.env?.PROXY_PORT_TRANSACTION).toBe(String(poolerContainerPorts.transaction));
    expect(def.args).toContain(`54329:${poolerContainerPorts.admin}`);
    expect(def.args).toContain(`54330:${poolerContainerPorts.session}`);
    expect(def.args).toContain(`54331:${poolerContainerPorts.transaction}`);
  });
});
