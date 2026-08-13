import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { candidateCleanupTargets, cleanupAutoManagedPaths } from "./cleanup.ts";
import { dockerContainerName } from "./StackIdentity.ts";
import { runForegroundOperation, type StackHandle } from "./createStack.ts";
import { StackReadinessError } from "./errors.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";
import {
  DEFAULT_MANAGED_STACK_NAME,
  projectKeyForProjectDir,
  shortTempPrefixRoot,
} from "./paths.ts";
import { stackMetadata } from "./StackMetadata.ts";
import type {
  AuthConfig,
  PostgresConfig,
  PostgrestConfig,
  ReadyOptions,
  StackConfig,
} from "./StackConfig.ts";
import {
  resolveConfig,
  resolveDaemonConfig,
  sanitizeDaemonConfigInput,
} from "./StackConfigResolver.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const DEFAULT_PORTS: AllocatedPorts = {
  apiPort: 54321,
  dbPort: 54322,
  authPort: 55001,
  postgrestPort: 55002,
  postgrestAdminPort: 55003,
  edgeRuntimePort: 55004,
  edgeRuntimeInspectorPort: 55005,
  realtimePort: 55006,
  storagePort: 55007,
  imgproxyPort: 55008,
  mailpitPort: 54324,
  mailpitSmtpPort: 54325,
  mailpitPop3Port: 54326,
  pgmetaPort: 55009,
  studioPort: 54323,
  analyticsPort: 54327,
  poolerPort: 54329,
  poolerApiPort: 55010,
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
        services: DEFAULT_VERSIONS,
        launch: { mode: "auto", excludedServices: [] },
      }),
      null,
      2,
    ),
  );
}

describe("foreground operation lifecycle", () => {
  it("disposes the foreground runtime after a direct readiness timeout", async () => {
    let disposeCount = 0;
    const operation = Promise.reject(
      new StackReadinessError({
        target: "stack",
        timeoutMs: 10,
        detail: "Timed out waiting for stack readiness",
      }),
    );

    await expect(
      runForegroundOperation(
        operation,
        async () => true,
        async () => {
          disposeCount += 1;
        },
      ),
    ).rejects.toMatchObject({ code: "STACK_READINESS_TIMEOUT" });
    expect(disposeCount).toBe(1);
  });

  it("disposes the foreground runtime after another terminal start failure", async () => {
    let disposeCount = 0;

    await expect(
      runForegroundOperation(
        Promise.reject(new Error("service startup failed")),
        async () => true,
        async () => {
          disposeCount += 1;
        },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(disposeCount).toBe(1);
  });

  it("keeps the foreground runtime open after a non-terminal operation failure", async () => {
    let disposeCount = 0;

    await expect(
      runForegroundOperation(
        Promise.reject(new Error("failed")),
        async () => false,
        async () => {
          disposeCount += 1;
        },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(disposeCount).toBe(0);
  });
});

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
      const _startupMode: "eager" | "lazy" | undefined = _config.startupMode;
      const _projectDir: string | undefined = _config.projectDir;
      const _functions = _config.functions;
      const _postgres: PostgresConfig | undefined = _config.postgres;
      const _postgrest: PostgrestConfig | false | undefined = _config.postgrest;
      const _auth: AuthConfig | false | undefined = _config.auth;
      const _port: number | undefined = _config.port;
      const _publishableKey: string | undefined = _config.publishableKey;
      const _secretKey: string | undefined = _config.secretKey;
      void _jwtSecret;
      void _startupMode;
      void _projectDir;
      void _functions;
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

  it("strips function bundles from daemon configuration at runtime", () => {
    const input = {
      cwd: "/project",
      functions: { environment: { SECRET: "must-not-cross-ipc" } },
    };

    expect(sanitizeDaemonConfigInput(input)).toEqual({ cwd: "/project" });
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

describe("resolveConfig edge runtime defaults", () => {
  it("disables edge runtime when omitted in native mode", async () => {
    const config = await resolveConfig({ mode: "native" });

    expect(config.mode).toBe("native");
    expect(config.edgeRuntime).toBe(false);
  });

  it("enables edge runtime when omitted in auto mode", async () => {
    const config = await resolveConfig();

    expect(config.mode).toBe("auto");
    expect(config.edgeRuntime).toEqual(
      expect.objectContaining({
        enabled: true,
        version: DEFAULT_VERSIONS["edge-runtime"],
      }),
    );
  });

  it("preserves explicit edge runtime opt-in in native mode for builder validation", async () => {
    const config = await resolveConfig({ mode: "native", edgeRuntime: {} });

    expect(config.mode).toBe("native");
    expect(config.edgeRuntime).toEqual(
      expect.objectContaining({
        enabled: true,
        version: DEFAULT_VERSIONS["edge-runtime"],
      }),
    );
  });
});

describe("candidateCleanupTargets", () => {
  it("derives fallback Docker identities from enabled catalog services", async () => {
    const config = await resolveConfig({
      mode: "docker",
      auth: false,
      edgeRuntime: false,
      realtime: false,
      storage: false,
      imgproxy: false,
      mailpit: false,
      pgmeta: false,
      studio: false,
      analytics: false,
      vector: false,
      pooler: false,
    });

    expect(candidateCleanupTargets(config)).toEqual({
      dockerContainerNames: [
        dockerContainerName("postgres", String(config.apiPort)),
        dockerContainerName("postgrest", String(config.apiPort)),
      ],
    });
  });

  it("keys fallback Docker identities by the stack's own identity when it has one", async () => {
    const instanceId = "0f9d2b3c-4a5e-4c7d-8e9f-1a2b3c4d5e6f";
    const config = await resolveConfig({ mode: "docker", instanceId });

    expect(config.instanceId).toBe(instanceId);
    const { dockerContainerNames } = candidateCleanupTargets(config);
    expect(dockerContainerNames).toContain(dockerContainerName("postgres", instanceId));
    for (const name of dockerContainerNames) {
      expect(name).not.toContain(String(config.apiPort));
    }
  });
});

describe("resolveConfig instanceId validation", () => {
  it("rejects an instanceId that is not Docker-name-safe", async () => {
    await expect(resolveConfig({ instanceId: "../bad:id" })).rejects.toMatchObject({
      _tag: "StackBuildError",
      reason: "invalid_config",
    });
  });

  it("accepts a managed stack's UUID instanceId", async () => {
    const instanceId = "0f9d2b3c-4a5e-4c7d-8e9f-1a2b3c4d5e6f";
    const config = await resolveConfig({ instanceId });
    expect(config.instanceId).toBe(instanceId);
  });

  it("leaves instanceId undefined when omitted", async () => {
    const config = await resolveConfig();
    expect(config.instanceId).toBeUndefined();
  });
});

describe("resolveConfig startup mode", () => {
  it("keeps eager startup as the package default", async () => {
    const config = await resolveConfig();
    expect(config.startupMode).toBe("eager");
  });

  it("preserves an explicit lazy startup mode", async () => {
    const config = await resolveConfig({ startupMode: "lazy" });
    expect(config.startupMode).toBe("lazy");
  });
});

describe("resolveConfig state roots", () => {
  it("uses disposable temporary roots when direct callers omit them", async () => {
    const config = await resolveConfig({ startupMode: "lazy" });

    try {
      expect(config.autoManagedPaths).toEqual([config.stackRoot, config.runtimeRoot]);
      expect(dirname(config.stackRoot)).toBe(shortTempPrefixRoot());
      expect(dirname(config.runtimeRoot)).toBe(shortTempPrefixRoot());
      expect(basename(config.stackRoot)).toMatch(/^sb-stack-/);
      expect(basename(config.runtimeRoot)).toMatch(/^sb-run-/);
      expect(existsSync(config.stackRoot)).toBe(true);
      expect(existsSync(config.runtimeRoot)).toBe(true);
    } finally {
      cleanupAutoManagedPaths(config);
    }

    expect(existsSync(config.stackRoot)).toBe(false);
    expect(existsSync(config.runtimeRoot)).toBe(false);
  });
});

describe("resolveConfig readiness policy", () => {
  it("uses a finite package default", async () => {
    const config = await resolveConfig();
    expect(config.readiness).toEqual({ mode: "finite", timeoutMs: 180_000 });
    expect(config.readinessSource).toBe("default");
  });

  it("preserves an explicit infinite policy", async () => {
    const config = await resolveConfig({ readiness: { mode: "infinite" } });
    expect(config.readiness).toEqual({ mode: "infinite" });
    expect(config.readinessSource).toBe("configured");
  });
});
