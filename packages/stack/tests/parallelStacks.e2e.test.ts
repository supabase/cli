import { type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { terminateChildProcess } from "../src/terminateChild.ts";
import {
  takeLeakSnapshot,
  waitForLeakSnapshot,
  diffLeakArtifacts,
  cleanupLeakArtifacts,
  type LeakSnapshot,
} from "./helpers/leaks.ts";
import { type SpawnedStackInfo, spawnStandaloneStack } from "./helpers/spawn-stack.ts";

const STACK_COUNT = 2;
const PARALLEL_STACK_TEST_TIMEOUT_MS = 5_000;

describe("parallel stacks (multi-process)", () => {
  const stacks: SpawnedStackInfo[] = [];
  // Registered at spawn time, not readiness: when one stack fails bring-up,
  // `Promise.all` discards its healthy siblings' values, so this list — not
  // `stacks` — is what teardown owns.
  const children: ChildProcess[] = [];
  let leakBaseline: LeakSnapshot;

  beforeAll(async () => {
    leakBaseline = takeLeakSnapshot({
      homeDir: homedir(),
      processNeedles: ["standalone-stack.ts"],
    });
    const results = await Promise.all(
      Array.from({ length: STACK_COUNT }, () =>
        spawnStandaloneStack({ onSpawn: (child) => children.push(child) }),
      ),
    );
    stacks.push(...results);
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled(
      children.map((child) => terminateChildProcess(child, { timeoutMs: 30_000 })),
    );

    const after = await waitForLeakSnapshot(
      () =>
        takeLeakSnapshot({
          homeDir: homedir(),
          processNeedles: ["standalone-stack.ts"],
        }),
      (current) => {
        const leaks = diffLeakArtifacts(leakBaseline, current);
        return (
          leaks.tempDataDirs.length === 0 &&
          leaks.containers.length === 0 &&
          leaks.trackedProcessPids.length === 0
        );
      },
      { timeoutMs: 60_000 },
    );
    const leaks = diffLeakArtifacts(leakBaseline, after);

    try {
      expect(leaks.tempDataDirs).toEqual([]);
      expect(leaks.containers).toEqual([]);
      expect(leaks.trackedProcessPids).toEqual([]);
    } finally {
      cleanupLeakArtifacts(leaks);
    }
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
      const responses = await Promise.all(stacks.map((s) => fetch(`${s.url}/health`)));
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    },
  );
});
