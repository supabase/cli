import { describe, expect, it } from "@effect/vitest";
import { createStackE2eCleanupManager } from "../../../tests/helpers/stack-e2e-cleanup.ts";

describe("stack e2e cleanup manager", () => {
  it("cleans a registered stack project and associated home once", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager({
      stopStack: async (projectDir, homeDir) => {
        calls.push(`stop:${projectDir}:${homeDir}`);
        return { exitCode: 0 };
      },
      captureSnapshot: () => ({
        stateFiles: ["/tmp/state.json"],
        socketPaths: [],
        stackDirs: ["/tmp/stack"],
        trackedPids: [],
      }),
      waitForCleanup: async () => true,
      forceCleanup: async () => {
        calls.push("force");
      },
    });

    manager.registerHome({
      dir: "/tmp/home",
      dispose: () => {
        calls.push("dispose-home");
      },
    });
    manager.registerStackProject({
      dir: "/tmp/project",
      cleanup: async () => {
        calls.push("cleanup-project");
      },
    });
    manager.associateHome("/tmp/project", "/tmp/home");

    await manager.drain();

    expect(calls).toEqual(["stop:/tmp/project:/tmp/home", "cleanup-project", "dispose-home"]);
  });

  it("ignores non-stack homes", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager({
      stopStack: async () => {
        calls.push("stop");
        return { exitCode: 0 };
      },
      captureSnapshot: () => ({
        stateFiles: [],
        socketPaths: [],
        stackDirs: [],
        trackedPids: [],
      }),
      waitForCleanup: async () => true,
      forceCleanup: async () => {
        calls.push("force");
      },
    });

    manager.registerHome({
      dir: "/tmp/home",
      dispose: () => {
        calls.push("dispose-home");
      },
    });

    await manager.drain();

    expect(calls).toEqual([]);
  });

  it("fails when graceful cleanup leaves leaked resources behind", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager({
      stopStack: async () => {
        calls.push("stop");
        return { exitCode: 0 };
      },
      captureSnapshot: () => ({
        stateFiles: ["/tmp/state.json"],
        socketPaths: ["/tmp/daemon.sock"],
        stackDirs: ["/tmp/stack"],
        trackedPids: [123],
      }),
      waitForCleanup: async () => false,
      forceCleanup: async () => {
        calls.push("force");
      },
    });

    manager.registerHome({
      dir: "/tmp/home",
      dispose: () => {
        calls.push("dispose-home");
      },
    });
    manager.registerStackProject({
      dir: "/tmp/project",
      cleanup: async () => {
        calls.push("cleanup-project");
      },
    });
    manager.associateHome("/tmp/project", "/tmp/home");

    await expect(manager.drain()).rejects.toThrow("leaked stack resources");
    expect(calls).toEqual(["stop", "force", "cleanup-project", "dispose-home"]);
  });
});
