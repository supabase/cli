import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { candidateCleanupTargets, cleanupAutoManagedPaths } from "./cleanup.ts";
import { dockerContainerName } from "./StackIdentity.ts";
import { runForegroundOperation } from "./createStack.ts";
import { StackReadinessError } from "./errors.ts";
import { shortTempPrefixRoot } from "./paths.ts";
import { resolveConfig, sanitizeDaemonConfigInput } from "./StackConfigResolver.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

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

describe("StackConfigResolver", () => {
  it("strips function bundles from daemon configuration at runtime", () => {
    const input = {
      cwd: "/project",
      functions: { environment: { SECRET: "must-not-cross-ipc" } },
    };

    expect(sanitizeDaemonConfigInput(input)).toEqual({ cwd: "/project" });
  });
});

describe("resolveConfig edge runtime defaults", () => {
  it("disables edge runtime when omitted in native mode", async () => {
    const config = await resolveConfig({ mode: "native" });

    expect(config.mode).toBe("native");
    expect(config.edgeRuntime).toBe(false);
  });

  it("enables edge runtime when omitted in Docker mode", async () => {
    const config = await resolveConfig(
      { mode: "docker" },
      { runtime: { mode: "docker", containerRuntime: "docker" } },
    );

    expect(config.mode).toBe("docker");
    expect(config.edgeRuntime).toEqual(
      expect.objectContaining({
        enabled: true,
        version: DEFAULT_VERSIONS["edge-runtime"],
      }),
    );
  });

  it("requires Effect consumers to provide the selected Docker runtime", async () => {
    await expect(resolveConfig({ mode: "docker" })).rejects.toMatchObject({
      _tag: "StackBuildError",
      reason: "invalid_config",
    });
  });

  it("applies the detected Docker mode before resolving services and ports", async () => {
    const config = await resolveConfig(undefined, {
      runtime: { mode: "docker", containerRuntime: "podman" },
    });

    expect(config.mode).toBe("docker");
    expect(config.containerRuntime).toBe("podman");
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

describe("resolveConfig explicit keyless ports", () => {
  it("preserves an explicit pooler api port", async () => {
    const config = await resolveConfig(
      {
        mode: "docker",
        edgeRuntime: false,
        postgrest: false,
        auth: false,
        pooler: { port: 42423, apiPort: 42424 },
      },
      { runtime: { mode: "docker", containerRuntime: "docker" } },
    );

    expect(config.ports.poolerPort).toBe(42423);
    expect(config.ports.poolerApiPort).toBe(42424);
  });

  it("orders explicit ports before omitted fields claim their preferred values", async () => {
    const sharedCandidate = 61_234;
    const config = await resolveConfig(
      {
        mode: "native",
        edgeRuntime: false,
        postgrest: false,
        auth: false,
        analytics: { port: sharedCandidate },
      },
      {
        preferredPorts: { dbPort: sharedCandidate },
        portAllocator: (requests) => {
          expect(requests[0]).toEqual({
            field: "analyticsPort",
            selection: { kind: "exact", port: sharedCandidate },
          });
          return Effect.succeed({
            apiPort: 61_233,
            dbPort: 61_235,
            analyticsPort: sharedCandidate,
          });
        },
      },
    );

    expect(config.ports.analyticsPort).toBe(sharedCandidate);
    expect(config.ports.dbPort).not.toBe(sharedCandidate);
  });
});

describe("candidateCleanupTargets", () => {
  it("derives fallback Docker identities from enabled catalog services", async () => {
    const config = await resolveConfig(
      {
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
      },
      { runtime: { mode: "docker", containerRuntime: "docker" } },
    );

    expect(candidateCleanupTargets(config)).toEqual({
      dockerContainerNames: [
        dockerContainerName("postgres", String(config.apiPort)),
        dockerContainerName("postgrest", String(config.apiPort)),
      ],
    });
  });

  it("keys fallback Docker identities by the stack's own identity when it has one", async () => {
    const instanceId = "0f9d2b3c-4a5e-4c7d-8e9f-1a2b3c4d5e6f";
    const config = await resolveConfig(
      { mode: "docker", instanceId },
      { runtime: { mode: "docker", containerRuntime: "docker" } },
    );

    expect(config.instanceId).toBe(instanceId);
    const { dockerContainerNames } = candidateCleanupTargets(config);
    expect(dockerContainerNames).toContain(dockerContainerName("postgres", `id-${instanceId}`));
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

describe("resolveConfig service policies", () => {
  it("uses catalog defaults and resolves explicit policies", async () => {
    const config = await resolveConfig({ servicePolicies: { postgrest: "eager" } });
    expect(config.servicePolicies.postgres).toBe("eager");
    expect(config.servicePolicies.postgrest).toBe("eager");
    expect(config.servicePolicies.auth).toBe("lazy");
  });
});

describe("resolveConfig state roots", () => {
  it("uses disposable temporary roots when direct callers omit them", async () => {
    const config = await resolveConfig();

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
