import { describe, expect, it, vi } from "@effect/vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureStackRuntimeSnapshot,
  createStackE2eCleanupManager,
} from "../../../tests/helpers/stack-e2e-cleanup.ts";

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
      managedStacksRootExists: false,
      documentFiles: [],
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
  it("discovers current managed state by identity project root", () => {
    const root = mkdtempSync(join(tmpdir(), "stack-e2e-cleanup-state-"));
    const project = join(root, "project");
    const stackId = "a".repeat(64);
    const stackDir = join(root, "home", "managed", "stacks", stackId);
    const stateFile = join(stackDir, "state.json");

    try {
      mkdirSync(project, { recursive: true });
      mkdirSync(stackDir, { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify({
          identity: { projectRoot: realpathSync(project) },
        }),
      );
      writeFileSync(
        join(stackDir, "control.json"),
        JSON.stringify({
          format: "supabase-stack-owner-v1",
          stackId,
          ownerSessionId: "owner-session",
          leasePort: 45_001,
          endpoint: { kind: "unix", path: "/tmp/supabase-stack.sock" },
          rpcRelease: "test",
        }),
      );

      const normalizedStackDir = realpathSync(stackDir);
      expect(captureStackRuntimeSnapshot(project, join(root, "home"))).toMatchObject({
        managedStacksRootExists: true,
        documentFiles: [join(normalizedStackDir, "state.json")],
        stackDirs: [normalizedStackDir],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans a registered stack project and associated home once", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(
      cleanupEnvironment(calls, {
        captureSnapshot: () => ({
          managedStacksRootExists: true,
          documentFiles: ["/tmp/stack.json"],
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

  it("canonicalizes symlinked project and home paths before matching stack state", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-e2e-cleanup-"));
    const project = join(root, "project");
    const projectLink = join(root, "project-link");
    const home = join(root, "home");
    const homeLink = join(root, "home-link");
    mkdirSync(project);
    mkdirSync(home);
    symlinkSync(project, projectLink);
    symlinkSync(home, homeLink);

    const snapshots: Array<{ readonly projectDir: string; readonly homeDir?: string }> = [];
    const manager = createStackE2eCleanupManager(
      cleanupEnvironment([], {
        captureSnapshot: (projectDir, homeDir) => {
          snapshots.push({ projectDir, homeDir });
          return {
            managedStacksRootExists: false,
            documentFiles: [],
            stackDirs: [],
            trackedPids: [],
          };
        },
      }),
    );

    try {
      manager.registerHome({ dir: homeLink, dispose: () => {} });
      manager.registerStackProject({ dir: projectLink, cleanup: async () => {} });
      manager.associateHome(projectLink, homeLink);
      await manager.drain();

      expect(snapshots).toEqual([
        { projectDir: realpathSync(project), homeDir: realpathSync(home) },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves project and home cleanup receivers", async () => {
    class ReceiverHome {
      readonly dir = "/tmp/home";
      disposed = false;

      dispose() {
        this.disposed = true;
      }
    }

    class ReceiverProject {
      readonly dir = "/tmp/project";
      cleaned = false;

      async cleanup() {
        this.cleaned = true;
      }
    }

    const home = new ReceiverHome();
    const project = new ReceiverProject();
    const manager = createStackE2eCleanupManager(cleanupEnvironment([]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      manager.registerHome(home);
      manager.registerStackProject(project);
      manager.associateHome(project.dir, home.dir);

      await manager.drain();

      expect(project.cleaned).toBe(true);
      expect(home.disposed).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
          managedStacksRootExists: true,
          documentFiles: ["/tmp/stack.json"],
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
          managedStacksRootExists: true,
          documentFiles: [],
          stackDirs: ["/tmp/home/managed/stacks/stack-id"],
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

  it("removes permission-blocked associated homes with the Docker root fallback", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(
      cleanupEnvironment(calls, {
        removeProjectWithDocker: async () => {
          calls.push("docker-remove");
          return true;
        },
      }),
    );

    manager.registerHome({
      dir: "/tmp/home",
      dispose: () => {
        calls.push("dispose-home");
        throw permissionError();
      },
    });
    manager.registerStackProject({
      dir: "/tmp/project",
      cleanup: async () => {
        calls.push("cleanup-project");
      },
    });
    manager.associateHome("/tmp/project", "/tmp/home");

    await expect(manager.drain()).resolves.toBeUndefined();

    expect(calls).toEqual(["cleanup-project", "dispose-home", "docker-remove"]);
  });

  it("warns when an associated home remains after permission fallback", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(cleanupEnvironment(calls));

    manager.registerHome({
      dir: "/tmp/home",
      dispose: () => {
        calls.push("dispose-home");
        throw permissionError();
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
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to remove temp home"));
    } finally {
      warn.mockRestore();
    }
    expect(calls).toEqual([
      "cleanup-project",
      "dispose-home",
      "docker-remove",
      "chmod",
      "dispose-home",
    ]);
  });

  it("disposes an associated home once after all projects sharing it are cleaned", async () => {
    const calls: Array<string> = [];
    const manager = createStackE2eCleanupManager(cleanupEnvironment(calls));

    manager.registerHome({
      dir: "/tmp/home",
      dispose: () => {
        calls.push("dispose-home");
      },
    });
    manager.registerStackProject({
      dir: "/tmp/project-one",
      cleanup: async () => {
        calls.push("cleanup-project-one");
      },
    });
    manager.registerStackProject({
      dir: "/tmp/project-two",
      cleanup: async () => {
        calls.push("cleanup-project-two");
      },
    });
    manager.associateHome("/tmp/project-one", "/tmp/home");
    manager.associateHome("/tmp/project-two", "/tmp/home");

    await manager.drain();

    expect(calls).toEqual(["cleanup-project-one", "cleanup-project-two", "dispose-home"]);
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
