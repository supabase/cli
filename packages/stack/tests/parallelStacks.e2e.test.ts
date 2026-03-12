import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { terminateChildProcess } from "../src/terminateChild.ts";
import {
  takeLeakSnapshot,
  waitForLeakSnapshot,
  diffLeakArtifacts,
  cleanupLeakArtifacts,
  type LeakSnapshot,
} from "./helpers/leaks.ts";

const STACK_COUNT = 2;
const SCRIPT = resolve(import.meta.dirname, "helpers/standalone-stack.ts");

interface StackInfo {
  url: string;
  dbUrl: string;
  process: ChildProcess;
}

function spawnStack(): Promise<StackInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", SCRIPT, "--parent-pid", String(process.pid)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        try {
          const info = JSON.parse(stdout.slice(0, newline));
          resolve({
            url: info.url,
            dbUrl: info.dbUrl,
            process: child,
          });
        } catch {
          reject(new Error(`Failed to parse stack info: ${stdout.slice(0, newline)}`));
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Stack process exited with code ${code}\nstderr: ${stderr}`));
      }
    });
  });
}

describe("parallel stacks (multi-process)", () => {
  const stacks: StackInfo[] = [];
  let leakBaseline: LeakSnapshot;

  beforeAll(async () => {
    leakBaseline = takeLeakSnapshot({
      homeDir: homedir(),
      processNeedles: ["standalone-stack.ts"],
    });
    const results = await Promise.all(Array.from({ length: STACK_COUNT }, () => spawnStack()));
    stacks.push(...results);
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled(
      stacks.map((s) => terminateChildProcess(s.process, { timeoutMs: 30_000 })),
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

  test("all stacks use different API ports", () => {
    const ports = stacks.map((s) => new URL(s.url).port);
    expect(new Set(ports).size).toBe(STACK_COUNT);
  });

  test("all stacks use different DB ports", () => {
    const ports = stacks.map((s) => new URL(s.dbUrl).port);
    expect(new Set(ports).size).toBe(STACK_COUNT);
  });

  test("all stacks respond to health checks", async () => {
    const responses = await Promise.all(stacks.map((s) => fetch(`${s.url}/health`)));
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });
});
