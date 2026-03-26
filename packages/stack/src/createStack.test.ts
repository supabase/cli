import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadyOptions, StackHandle } from "./createStack.ts";
import { resolveDaemonConfig } from "./createStack.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";
import { DEFAULT_MANAGED_STACK_NAME, projectKeyForProjectDir } from "./paths.ts";
import { stackMetadata } from "./StackMetadata.ts";
import type { AuthConfig, PostgresConfig, PostgrestConfig, StackConfig } from "./StackBuilder.ts";

const DEFAULT_PORTS: AllocatedPorts = {
  apiPort: 54321,
  dbPort: 54322,
  authPort: 55001,
  postgrestPort: 55002,
  postgrestAdminPort: 55003,
  realtimePort: 55004,
  storagePort: 55005,
  imgproxyPort: 55006,
  mailpitPort: 54324,
  mailpitSmtpPort: 54325,
  mailpitPop3Port: 54326,
  pgmetaPort: 55007,
  studioPort: 54323,
  analyticsPort: 54327,
  poolerPort: 54329,
  poolerApiPort: 55008,
};

function withTempCacheRoot(run: (cacheRoot: string) => Promise<void>) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "supabase-cache-"));
  return run(cacheRoot).finally(() => {
    rmSync(cacheRoot, { force: true, recursive: true });
  });
}

function writeStackMetadata(
  cacheRoot: string,
  projectDir: string,
  name: string,
  ports: AllocatedPorts,
) {
  const stackDir = join(cacheRoot, "projects", projectKeyForProjectDir(projectDir), "stacks", name);
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(
    join(stackDir, "stack.json"),
    JSON.stringify(
      stackMetadata({
        ports,
        services: {
          postgres: "17.6.1.081",
          postgrest: "14.5",
          auth: "2.188.0-rc.15",
          realtime: "2.78.10",
          storage: "1.41.8",
          imgproxy: "v3.8.0",
          mailpit: "v1.22.3",
          pgmeta: "0.96.1",
          studio: "2026.03.04-sha-0043607",
          analytics: "1.34.7",
          vector: "0.28.1-alpine",
          pooler: "2.7.4",
        },
      }),
      null,
      2,
    ),
  );
}

describe("createStack types", () => {
  it("StackHandle interface has expected shape", () => {
    const check = (_stack: StackHandle) => {
      const _url: string = _stack.url;
      const _publishableKey: string = _stack.publishableKey;
      const _secretKey: string = _stack.secretKey;
      const _dbUrl: string = _stack.dbUrl;
      const _start: () => Promise<void> = _stack.start;
      const _stop: () => Promise<void> = _stack.stop;
      const _dispose: () => Promise<void> = _stack.dispose;
      const _startService: (name: string) => Promise<void> = _stack.startService;
      const _stopService: (name: string) => Promise<void> = _stack.stopService;
      const _restartService: (name: string) => Promise<void> = _stack.restartService;
      const _ready: (opts?: ReadyOptions) => Promise<void> = _stack.ready;
      const _serviceReady: (name: string, opts?: ReadyOptions) => Promise<void> =
        _stack.serviceReady;
    };
    expect(check).toBeDefined();
  });

  it("StackConfig interface has expected shape", () => {
    const check = (_config: StackConfig) => {
      const _jwtSecret: string | undefined = _config.jwtSecret;
      const _postgres: PostgresConfig | undefined = _config.postgres;
      const _postgrest: PostgrestConfig | false | undefined = _config.postgrest;
      const _auth: AuthConfig | false | undefined = _config.auth;
      const _port: number | undefined = _config.port;
      const _publishableKey: string | undefined = _config.publishableKey;
      const _secretKey: string | undefined = _config.secretKey;
      void _jwtSecret;
      void _postgres;
      void _postgrest;
      void _auth;
      void _port;
      void _publishableKey;
      void _secretKey;
    };
    expect(check).toBeDefined();
  });

  it("resolveDaemonConfig derives the default stack name and projectDir from cwd", async () => {
    const config = await resolveDaemonConfig({
      cacheRoot: "/tmp/supabase-home",
      cwd: "/Users/test/Code/myapp",
      postgres: {
        dataDir: "/tmp/supabase-data",
      },
    });

    expect(config.name).toBe(DEFAULT_MANAGED_STACK_NAME);
    expect(config.projectDir).toBe("/Users/test/Code/myapp");
    expect(config.cacheRoot).toBe("/tmp/supabase-home");
    expect(config.stackRoot).toBe(
      join(
        "/tmp/supabase-home",
        "projects",
        projectKeyForProjectDir("/Users/test/Code/myapp"),
        "stacks",
        DEFAULT_MANAGED_STACK_NAME,
      ),
    );
  });

  it("resolveDaemonConfig prefers legacy defaults for a first named stack", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const config = await resolveDaemonConfig({
        cacheRoot,
        cwd: "/Users/test/Code/myapp",
      });

      expect(config.ports.apiPort).toBe(54321);
      expect(config.ports.dbPort).toBe(54322);
      expect(config.ports.studioPort).toBe(54323);
      expect(config.ports.mailpitPort).toBe(54324);
      expect(config.ports.analyticsPort).toBe(54327);
      expect(config.ports.poolerPort).toBe(54329);
    });
  });

  it("a second named stack does not steal another stack's saved legacy ports", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      writeStackMetadata(cacheRoot, "/Users/test/Code/stack-a", "stack-a", DEFAULT_PORTS);

      const config = await resolveDaemonConfig({
        cacheRoot,
        cwd: "/Users/test/Code/stack-b",
        name: "stack-b",
      });

      expect(config.ports.apiPort).not.toBe(DEFAULT_PORTS.apiPort);
      expect(config.ports.dbPort).not.toBe(DEFAULT_PORTS.dbPort);
      expect(config.ports.studioPort).not.toBe(DEFAULT_PORTS.studioPort);
      expect(config.ports.mailpitPort).not.toBe(DEFAULT_PORTS.mailpitPort);
      expect(config.ports.analyticsPort).not.toBe(DEFAULT_PORTS.analyticsPort);
      expect(config.ports.poolerPort).not.toBe(DEFAULT_PORTS.poolerPort);
    });
  });

  it("resolveDaemonConfig reuses the saved full port set for the same stack", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const savedPorts: AllocatedPorts = {
        ...DEFAULT_PORTS,
        apiPort: 55121,
        dbPort: 55122,
        authPort: 55123,
        poolerApiPort: 55124,
      };
      writeStackMetadata(
        cacheRoot,
        "/Users/test/Code/myapp",
        DEFAULT_MANAGED_STACK_NAME,
        savedPorts,
      );

      const config = await resolveDaemonConfig({
        cacheRoot,
        cwd: "/Users/test/Code/myapp",
      });

      expect(config.ports).toEqual(savedPorts);
      expect(config.apiPort).toBe(savedPorts.apiPort);
      expect(config.dbPort).toBe(savedPorts.dbPort);
    });
  });

  it("explicit user ports cannot override another stack's saved ownership", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      writeStackMetadata(cacheRoot, "/Users/test/Code/stack-a", "stack-a", DEFAULT_PORTS);

      await expect(
        resolveDaemonConfig({
          cacheRoot,
          cwd: "/Users/test/Code/stack-b",
          name: "stack-b",
          port: DEFAULT_PORTS.apiPort,
        }),
      ).rejects.toThrow("Port 54321 is not available");
    });
  });
});
