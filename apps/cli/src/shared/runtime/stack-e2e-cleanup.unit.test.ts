import { describe, expect, it, vi } from "@effect/vitest";
import { createStackE2eCleanupManager } from "../../../tests/helpers/stack-e2e-cleanup.ts";

function permissionError(message = "permission denied") {
  return Object.assign(new Error(message), { code: "EACCES" });
}

function cleanupEnvironment(
  calls: Array<string>,
  overrides: Partial<Parameters<typeof createStackE2eCleanupManager>[0]> = {},
): Parameters<typeof createStackE2eCleanupManager>[0] {
  return {
    stopStack: async (projectDir, homeDir) => {
      calls.push(`stop:${projectDir}:${homeDir}`);
      return { exitCode: 0 };
    },
    captureSnapshot: () => ({
      stacksRootExists: false,
      stateFiles: [],
      socketPaths: [],
      stackDirs: [],
      trackedPids: [],
    }),
    waitForCleanup: async () => true,
    forceCleanup: async () => {
      calls.push("force");
    },
    removeProjectWithDocker: async () => {
      calls.push("docker-remove");
      return false;
    },
    repairProjectPermissions: () => {
      calls.push("chmod");
    },
    describeProjectPermissions: () => "Permission diagnostics:\n/tmp/project uid=0 gid=0 mode=0755",
    ...overrides,
  };
}

describe("stack e2e cleanup manager", () => {
  it("cleans a registered stack project and associated home once", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(
      cleanupEnvironment(calls, {
        captureSnapshot: () => ({
          stacksRootExists: true,
          stateFiles: ["/tmp/state.json"],
          socketPaths: [],
          stackDirs: ["/tmp/stack"],
          trackedPids: [],
        }),
      }),
    );

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
    const manager = createStackE2eCleanupManager(cleanupEnvironment(calls));

    manager.registerHome({
      dir: "/tmp/home",
      dispose: () => {
        calls.push("dispose-home");
      },
    });

    await manager.drain();

    expect(calls).toEqual([]);
  });

  it("warns when graceful cleanup leaves leaked resources behind", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(
      cleanupEnvironment(calls, {
        stopStack: async () => {
          calls.push("stop");
          return { exitCode: 0 };
        },
        captureSnapshot: () => ({
          stacksRootExists: true,
          stateFiles: ["/tmp/state.json"],
          socketPaths: ["/tmp/daemon.sock"],
          stackDirs: ["/tmp/stack"],
          trackedPids: [123],
        }),
        waitForCleanup: async () => false,
      }),
    );

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

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(manager.drain()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("leaked stack resources"));
    } finally {
      warn.mockRestore();
    }
    expect(calls).toEqual(["stop", "force", "cleanup-project", "dispose-home"]);
  });

  it("stops persisted stack directories even when no live runtime artifacts remain", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(
      cleanupEnvironment(calls, {
        captureSnapshot: () => ({
          stacksRootExists: true,
          stateFiles: [],
          socketPaths: [],
          stackDirs: ["/tmp/project/.supabase/stacks/default"],
          trackedPids: [],
        }),
      }),
    );

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

  it("removes permission-blocked projects with the Docker root fallback", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(
      cleanupEnvironment(calls, {
        removeProjectWithDocker: async () => {
          calls.push("docker-remove");
          return true;
        },
      }),
    );

    manager.registerStackProject({
      dir: "/tmp/project",
      cleanup: async () => {
        calls.push("cleanup-project");
        throw permissionError();
      },
    });

    await manager.drain();

    expect(calls).toEqual(["cleanup-project", "docker-remove"]);
  });

  it("falls back to chmod and retries cleanup when Docker cannot remove the project", async () => {
    const calls: Array<string> = [];
    let attempts = 0;
    const manager = createStackE2eCleanupManager(cleanupEnvironment(calls));

    manager.registerStackProject({
      dir: "/tmp/project",
      cleanup: async () => {
        attempts += 1;
        calls.push(`cleanup-project:${attempts}`);
        if (attempts === 1) {
          throw permissionError();
        }
      },
    });

    await manager.drain();

    expect(calls).toEqual(["cleanup-project:1", "docker-remove", "chmod", "cleanup-project:2"]);
  });

  it("warns with permission diagnostics when fallback cleanup still cannot remove the project", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(cleanupEnvironment(calls));

    manager.registerStackProject({
      dir: "/tmp/project",
      cleanup: async () => {
        calls.push("cleanup-project");
        throw permissionError();
      },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(manager.drain()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Permission diagnostics:"));
    } finally {
      warn.mockRestore();
    }
    expect(calls).toEqual(["cleanup-project", "docker-remove", "chmod", "cleanup-project"]);
  });
});
