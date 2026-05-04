import { describe, expect, test } from "vitest";
import type { PrefetchOptions, PrefetchResult } from "../../src/node.ts";
import { STACK_E2E_WARMUP_SERVICES, warmStackE2eDependencies } from "./warmup.ts";

function makeLogger() {
  const warn: string[] = [];
  return {
    warn,
    logger: {
      warn: (message: string) => {
        warn.push(message);
      },
    },
  };
}

function makeResult(type: "binary" | "docker"): PrefetchResult {
  return {
    postgres:
      type === "docker" ? { type, image: "postgres:image" } : { type, path: "/tmp/postgres" },
    postgrest:
      type === "docker" ? { type, image: "postgrest:image" } : { type, path: "/tmp/postgrest" },
    auth: type === "docker" ? { type, image: "auth:image" } : { type, path: "/tmp/auth" },
    "edge-runtime":
      type === "docker"
        ? { type, image: "edge-runtime:image" }
        : { type, path: "/tmp/edge-runtime" },
  };
}

describe("stack e2e warmup", () => {
  test("runs auto prefetch and docker image warmup when Docker is available", async () => {
    const calls: Array<PrefetchOptions | undefined> = [];
    const { logger } = makeLogger();

    await warmStackE2eDependencies({
      logger,
      hasDockerDaemon: () => true,
      prefetch: async (options?: PrefetchOptions) => {
        calls.push(options);
        return options?.mode === "docker" ? makeResult("docker") : makeResult("binary");
      },
    });

    expect(calls).toEqual([
      { services: STACK_E2E_WARMUP_SERVICES },
      { mode: "docker", services: STACK_E2E_WARMUP_SERVICES },
    ]);
  });

  test("skips docker image warmup when Docker is unavailable", async () => {
    const calls: Array<PrefetchOptions | undefined> = [];
    const { logger } = makeLogger();

    await warmStackE2eDependencies({
      logger,
      hasDockerDaemon: () => false,
      prefetch: async (options?: PrefetchOptions) => {
        calls.push(options);
        return makeResult("binary");
      },
    });

    expect(calls).toEqual([{ services: STACK_E2E_WARMUP_SERVICES }]);
  });

  test("can fail fast when warmup is required", async () => {
    const { warn, logger } = makeLogger();

    await expect(
      warmStackE2eDependencies({
        failOnError: true,
        logger,
        prefetch: async () => {
          throw new Error("pull failed");
        },
      }),
    ).rejects.toThrow("pull failed");
    expect(warn.some((message) => message.includes("Warmup failed"))).toBe(true);
  });

  test("only warns when warmup is best effort", async () => {
    const { warn, logger } = makeLogger();

    await expect(
      warmStackE2eDependencies({
        failOnError: false,
        logger,
        prefetch: async () => {
          throw new Error("pull failed");
        },
      }),
    ).resolves.toBeUndefined();
    expect(warn.some((message) => message.includes("Warmup failed"))).toBe(true);
  });
});
