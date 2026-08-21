import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { candidateCleanupTargets, cleanupAutoManagedPaths } from "./cleanup.ts";
import { dockerContainerName } from "./StackIdentity.ts";
import { runForegroundOperation } from "./createStack.ts";
import { StackReadinessError } from "./errors.ts";
import { shortTempPrefixRoot } from "./paths.ts";
import {
  portRequestsForConfig,
  resolveConfig,
  sanitizeDaemonConfigInput,
  type ResolveConfigOptions,
} from "./StackConfigResolver.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const resolveConfigPromise = (
  config?: Parameters<typeof resolveConfig>[0],
  options: ResolveConfigOptions = {},
) => {
  const requests = Effect.runSync(portRequestsForConfig(config, options));
  const selected = new Set<number>();
  let fallback = 40_000;
  const ports = Object.fromEntries(
    requests.map((request) => {
      if (request.selection.kind === "exact") {
        selected.add(request.selection.port);
        return [request.field, request.selection.port];
      }
      let port = request.selection.preferred;
      while (port === undefined || selected.has(port)) port = fallback++;
      selected.add(port);
      return [request.field, port];
    }),
  );
  return Effect.runPromise(
    resolveConfig(config, { ...options, ports }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
};

describe("foreground operation lifecycle", () => {
  it("disposes the foreground runtime after a direct readiness timeout", async () => {
    let disposeCount = 0;
    const operation = Effect.fail(
      new StackReadinessError({
        target: "stack",
        timeoutMs: 10,
        detail: "Timed out waiting for stack readiness",
      }),
    );

    await expect(
      Effect.runPromise(
        runForegroundOperation(
          operation,
          Effect.succeed(true),
          Effect.sync(() => {
            disposeCount += 1;
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "STACK_READINESS_TIMEOUT" });
    expect(disposeCount).toBe(1);
  });

  it("disposes the foreground runtime after another terminal start failure", async () => {
    let disposeCount = 0;

    await expect(
      Effect.runPromise(
        runForegroundOperation(
          Effect.fail(new Error("service startup failed")),
          Effect.succeed(true),
          Effect.sync(() => {
            disposeCount += 1;
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(disposeCount).toBe(1);
  });

  it("keeps the foreground runtime open after a non-terminal operation failure", async () => {
    let disposeCount = 0;

    await expect(
      Effect.runPromise(
        runForegroundOperation(
          Effect.fail(new Error("failed")),
          Effect.succeed(false),
          Effect.sync(() => {
            disposeCount += 1;
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(disposeCount).toBe(0);
  });

  it("preserves interruption instead of converting it to a stack error", async () => {
    let disposeCount = 0;
    const fiber = Effect.runFork(
      runForegroundOperation(
        Effect.never,
        Effect.succeed(true),
        Effect.sync(() => {
          disposeCount += 1;
        }),
      ),
    );

    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
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
    const config = await resolveConfigPromise({ mode: "native" });

    expect(config.mode).toBe("native");
    expect(config.edgeRuntime).toBe(false);
  });

  it("enables edge runtime when omitted in auto mode", async () => {
    const config = await resolveConfigPromise();

    expect(config.mode).toBe("auto");
    expect(config.edgeRuntime).toEqual(
      expect.objectContaining({
        enabled: true,
        version: DEFAULT_VERSIONS["edge-runtime"],
      }),
    );
  });

  it("preserves explicit edge runtime opt-in in native mode for builder validation", async () => {
    const config = await resolveConfigPromise({ mode: "native", edgeRuntime: {} });

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
    const config = await resolveConfigPromise({
      mode: "docker",
      edgeRuntime: false,
      postgrest: false,
      auth: false,
      pooler: { port: 42423, apiPort: 42424 },
    });

    expect(config.ports.poolerPort).toBe(42423);
    expect(config.ports.poolerApiPort).toBe(42424);
  });

  it("orders explicit ports before omitted fields claim their preferred values", async () => {
    const sharedCandidate = 61_234;
    const input = {
      mode: "native" as const,
      edgeRuntime: false as const,
      postgrest: false as const,
      auth: false as const,
      analytics: { port: sharedCandidate },
    };
    const requests = Effect.runSync(
      portRequestsForConfig(input, { preferredPorts: { dbPort: sharedCandidate } }),
    );
    expect(requests[0]).toEqual({
      field: "analyticsPort",
      selection: { kind: "exact", port: sharedCandidate },
    });
    const config = await resolveConfigPromise(input, {
      preferredPorts: { dbPort: sharedCandidate },
      ports: { apiPort: 61_233, dbPort: 61_235, analyticsPort: sharedCandidate },
    });

    expect(config.ports.analyticsPort).toBe(sharedCandidate);
    expect(config.ports.dbPort).not.toBe(sharedCandidate);
  });
});

describe("candidateCleanupTargets", () => {
  it("derives fallback Docker identities from enabled catalog services", async () => {
    const config = await resolveConfigPromise({
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
    const config = await resolveConfigPromise({ mode: "docker", instanceId });

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
    await expect(resolveConfigPromise({ instanceId: "../bad:id" })).rejects.toMatchObject({
      _tag: "StackBuildError",
      reason: "invalid_config",
    });
  });

  it("accepts a managed stack's UUID instanceId", async () => {
    const instanceId = "0f9d2b3c-4a5e-4c7d-8e9f-1a2b3c4d5e6f";
    const config = await resolveConfigPromise({ instanceId });
    expect(config.instanceId).toBe(instanceId);
  });

  it("leaves instanceId undefined when omitted", async () => {
    const config = await resolveConfigPromise();
    expect(config.instanceId).toBeUndefined();
  });
});

describe("resolveConfig startup mode", () => {
  it("keeps eager startup as the package default", async () => {
    const config = await resolveConfigPromise();
    expect(config.startupMode).toBe("eager");
  });

  it("preserves an explicit lazy startup mode", async () => {
    const config = await resolveConfigPromise({ startupMode: "lazy" });
    expect(config.startupMode).toBe("lazy");
  });
});

describe("resolveConfig state roots", () => {
  it("uses disposable temporary roots when direct callers omit them", async () => {
    const config = await resolveConfigPromise({ startupMode: "lazy" });

    try {
      expect(config.autoManagedPaths).toEqual([config.stackRoot, config.runtimeRoot]);
      expect(dirname(config.stackRoot)).toBe(shortTempPrefixRoot());
      expect(dirname(config.runtimeRoot)).toBe(shortTempPrefixRoot());
      expect(basename(config.stackRoot)).toMatch(/^sb-stack-/);
      expect(basename(config.runtimeRoot)).toMatch(/^sb-run-/);
      expect(existsSync(config.stackRoot)).toBe(true);
      expect(existsSync(config.runtimeRoot)).toBe(true);
    } finally {
      await Effect.runPromise(
        cleanupAutoManagedPaths(config).pipe(Effect.provide(NodeFileSystem.layer)),
      );
    }

    expect(existsSync(config.stackRoot)).toBe(false);
    expect(existsSync(config.runtimeRoot)).toBe(false);
  });
});

describe("resolveConfig readiness policy", () => {
  it("uses a finite package default", async () => {
    const config = await resolveConfigPromise();
    expect(config.readiness).toEqual({ mode: "finite", timeoutMs: 180_000 });
    expect(config.readinessSource).toBe("default");
  });

  it("preserves an explicit infinite policy", async () => {
    const config = await resolveConfigPromise({ readiness: { mode: "infinite" } });
    expect(config.readiness).toEqual({ mode: "infinite" });
    expect(config.readinessSource).toBe("configured");
  });
});
