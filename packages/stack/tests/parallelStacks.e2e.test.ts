import { type ChildProcess } from "node:child_process";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { terminateChildProcess } from "../src/terminateChild.ts";
import { type SpawnedStackInfo, spawnStandaloneStack } from "./helpers/spawn-stack.ts";

const STACK_COUNT = 2;
const PARALLEL_STACK_TEST_TIMEOUT_MS = 30_000;

describe("parallel stacks (multi-process)", () => {
  const stacks: SpawnedStackInfo[] = [];
  // Registered at spawn time, not readiness: when one stack fails bring-up,
  // `Promise.all` discards its healthy siblings' values, so this list — not
  // `stacks` — is what teardown owns.
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    const results = await Promise.all(
      Array.from({ length: STACK_COUNT }, () =>
        spawnStandaloneStack({ onSpawn: (child) => children.push(child) }),
      ),
    );
    stacks.push(...results);
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled(
      children.map((child) =>
        Effect.runPromise(terminateChildProcess(child, { timeoutMs: 30_000 })),
      ),
    );
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
  }, 60_000);

  test("all stacks use different API ports", { timeout: PARALLEL_STACK_TEST_TIMEOUT_MS }, () => {
    const ports = stacks.map((s) => new URL(s.url).port);
    expect(new Set(ports).size).toBe(STACK_COUNT);
  });

  test("all stacks use different DB ports", { timeout: PARALLEL_STACK_TEST_TIMEOUT_MS }, () => {
    const ports = stacks.map((s) => new URL(s.dbUrl).port);
    expect(new Set(ports).size).toBe(STACK_COUNT);
  });

  test(
    "all stacks respond to health checks",
    { timeout: PARALLEL_STACK_TEST_TIMEOUT_MS },
    async () => {
      const responses = await Promise.all(
        stacks.map((s) => fetch(`${s.url}/health`, { signal: AbortSignal.timeout(20_000) })),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    },
  );
});
