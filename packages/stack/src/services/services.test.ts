import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeAuthServiceNative, makeAuthServiceDocker } from "./auth.ts";
import { makePostgresInitService } from "./postgres-init.ts";
import { makePostgresService, makePostgresServiceDocker } from "./postgres.ts";
import { makePostgrestService } from "./postgrest.ts";
import { DEFAULT_VERSIONS, dockerImageForService } from "../versions.ts";

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const DB_PORT = 54322;
const API_PORT = 54321;
const POSTGRES_BIN_PATH = `/cache/postgres/${DEFAULT_VERSIONS.postgres}/darwin-arm64`;
const POSTGREST_BIN_PATH = `/cache/postgrest/${DEFAULT_VERSIONS.postgrest}/macos-aarch64`;
const AUTH_BIN_PATH = `/cache/auth/${DEFAULT_VERSIONS.auth}/arm64`;

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
      networkArgs: ["--network=host"],
      jwtSecret: "test-jwt-secret-with-at-least-32-characters",
      jwtExpiry: 3600,
      apiPort: API_PORT,
    });

    expect(def.name).toBe("postgres");
    expect(def.command).toBe("docker");
    expect(def.args).toContain("run");
    expect(def.args).toContain("--rm");
    expect(def.args).toContain(`supabase-postgres-${API_PORT}`);
    expect(def.args).toContain("--network=host");
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
      networkArgs: ["--network=host"],
      apiPort: API_PORT,
      dependencies: [{ service: "postgres", condition: "healthy" }],
    });

    expect(def.name).toBe("auth");
    expect(def.command).toBe("docker");
    expect(def.args).toContain("run");
    expect(def.args).toContain("--rm");
    expect(def.args).toContain(`supabase-auth-${API_PORT}`);
    expect(def.args).toContain("--network=host");
    expect(def.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    expect(def.supervision).toEqual({
      orphanCleanup: [{ _tag: "DockerRemove", containerName: `supabase-auth-${API_PORT}` }],
    });
  });
});

describe("makePostgresInitService", () => {
  it("creates a one-shot postgres-init ServiceDef", () => {
    const def = makePostgresInitService({
      postgresDir: POSTGRES_BIN_PATH,
      dbPort: DB_PORT,
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
    });
    const script = def.args?.[1] as string;
    expect(script).not.toContain("set -e");
  });

  it("includes idempotency check for authenticator role", () => {
    const def = makePostgresInitService({
      postgresDir: "/cache/postgres/17/darwin-arm64",
      dbPort: DB_PORT,
    });
    const script = def.args?.[1] as string;
    expect(script).toContain("authenticator");
    expect(script).toContain("already initialized");
  });

  it("batches SQL files via chained -f flags instead of shelling out to migrate.sh", () => {
    const def = makePostgresInitService({
      postgresDir: "/cache/postgres/17/darwin-arm64",
      dbPort: DB_PORT,
    });
    const script = def.args?.[1] as string;
    expect(script).not.toMatch(/sh .+migrate\.sh/);
    expect(script).toContain("-f $sql");
    expect(script).toContain("init-scripts/*.sql");
    expect(script).toContain("migrations/*.sql");
  });
});
