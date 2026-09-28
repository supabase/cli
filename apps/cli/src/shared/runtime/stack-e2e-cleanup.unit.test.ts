import { BunServices } from "@effect/platform-bun";
import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { createStackE2eCleanupManager } from "../../../tests/helpers/stack-e2e-cleanup.ts";
import { CliHomeDisposeError } from "../../../tests/helpers/cli.ts";

function permissionError(message = "permission denied") {
  return Object.assign(new Error(message), { code: "EACCES" });
}

const drain = (manager: ReturnType<typeof createStackE2eCleanupManager>) =>
  Effect.promise(() => manager.drain());

function cleanupEnvironment(
  calls: Array<string>,
  overrides: Partial<Parameters<typeof createStackE2eCleanupManager>[0]> = {},
): Parameters<typeof createStackE2eCleanupManager>[0] {
  return {
    stopStack: (projectDir, homeDir) => {
      calls.push(`stop:${projectDir}:${homeDir}`);
      return Promise.resolve({ exitCode: 0 });
    },
    captureSnapshot: () => ({
      managedStacksRootExists: false,
      documentFiles: [],
      stackDirs: [],
      trackedPids: [],
    }),
    waitForCleanup: () => Promise.resolve(true),
    forceCleanup: () => {
      calls.push("force");
      return Promise.resolve();
    },
    removeProjectWithDocker: () => {
      calls.push("docker-remove");
      return Promise.resolve(false);
    },
    repairProjectPermissions: () => {
      calls.push("chmod");
    },
    describeProjectPermissions: () => "Permission diagnostics:\n/tmp/project uid=0 gid=0 mode=0755",
    ...overrides,
  };
}

describe("stack e2e cleanup manager", () => {
  it.effect("cleans a registered stack project and associated home once", () =>
    Effect.gen(function* () {
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
        cleanup: () => {
          calls.push("cleanup-project");
          return Promise.resolve();
        },
      });
      manager.associateHome("/tmp/project", "/tmp/home");

      yield* drain(manager);

      expect(calls).toEqual(["stop:/tmp/project:/tmp/home", "cleanup-project", "dispose-home"]);
    }),
  );

  it.effect("canonicalizes symlinked project and home paths before matching stack state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-e2e-cleanup-" });
      const project = path.join(root, "project");
      const projectLink = path.join(root, "project-link");
      const home = path.join(root, "home");
      const homeLink = path.join(root, "home-link");
      yield* fs.makeDirectory(project);
      yield* fs.makeDirectory(home);
      yield* fs.symlink(project, projectLink);
      yield* fs.symlink(home, homeLink);

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

      manager.registerHome({ dir: homeLink, dispose: () => {} });
      manager.registerStackProject({ dir: projectLink, cleanup: () => Promise.resolve() });
      manager.associateHome(projectLink, homeLink);
      yield* drain(manager);

      expect(snapshots).toEqual([
        { projectDir: yield* fs.realPath(project), homeDir: yield* fs.realPath(home) },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("preserves project and home cleanup receivers", () => {
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

      cleanup() {
        this.cleaned = true;
        return Promise.resolve();
      }
    }

    return Effect.gen(function* () {
      const warn = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(console, "warn").mockImplementation(() => {})),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const home = new ReceiverHome();
      const project = new ReceiverProject();
      const manager = createStackE2eCleanupManager(cleanupEnvironment([]));
      manager.registerHome(home);
      manager.registerStackProject(project);
      manager.associateHome(project.dir, home.dir);

      yield* drain(manager);

      expect(project.cleaned).toBe(true);
      expect(home.disposed).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it.effect("ignores non-stack homes", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const manager = createStackE2eCleanupManager(cleanupEnvironment(calls));

      manager.registerHome({
        dir: "/tmp/home",
        dispose: () => {
          calls.push("dispose-home");
        },
      });

      yield* drain(manager);

      expect(calls).toEqual([]);
    }),
  );

  it.effect("warns when graceful cleanup leaves leaked resources behind", () =>
    Effect.gen(function* () {
      const warn = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(console, "warn").mockImplementation(() => {})),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const calls: Array<string> = [];
      const manager = createStackE2eCleanupManager(
        cleanupEnvironment(calls, {
          stopStack: () => {
            calls.push("stop");
            return Promise.resolve({ exitCode: 0 });
          },
          captureSnapshot: () => ({
            managedStacksRootExists: true,
            documentFiles: ["/tmp/stack.json"],
            stackDirs: ["/tmp/stack"],
            trackedPids: [123],
          }),
          waitForCleanup: () => Promise.resolve(false),
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
        cleanup: () => {
          calls.push("cleanup-project");
          return Promise.resolve();
        },
      });
      manager.associateHome("/tmp/project", "/tmp/home");

      expect(yield* drain(manager)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("leaked stack resources"));
      expect(calls).toEqual(["stop", "force", "cleanup-project", "dispose-home"]);
    }),
  );

  it.effect("stops persisted stack directories even when no live runtime artifacts remain", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const manager = createStackE2eCleanupManager(
        cleanupEnvironment(calls, {
          captureSnapshot: () => ({
            managedStacksRootExists: true,
            documentFiles: [],
            stackDirs: ["/tmp/home/stacks/stack-id"],
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
        cleanup: () => {
          calls.push("cleanup-project");
          return Promise.resolve();
        },
      });
      manager.associateHome("/tmp/project", "/tmp/home");

      yield* drain(manager);

      expect(calls).toEqual(["stop:/tmp/project:/tmp/home", "cleanup-project", "dispose-home"]);
    }),
  );

  it.effect("removes permission-blocked projects with the Docker root fallback", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const manager = createStackE2eCleanupManager(
        cleanupEnvironment(calls, {
          removeProjectWithDocker: () => {
            calls.push("docker-remove");
            return Promise.resolve(true);
          },
        }),
      );

      manager.registerStackProject({
        dir: "/tmp/project",
        cleanup: () => {
          calls.push("cleanup-project");
          return Promise.reject(permissionError());
        },
      });

      yield* drain(manager);

      expect(calls).toEqual(["cleanup-project", "docker-remove"]);
    }),
  );

  it.effect("classifies a permission errno wrapped in a typed error's cause chain", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const manager = createStackE2eCleanupManager(
        cleanupEnvironment(calls, {
          removeProjectWithDocker: () => {
            calls.push("docker-remove");
            return Promise.resolve(true);
          },
        }),
      );

      manager.registerStackProject({
        dir: "/tmp/project",
        cleanup: () => {
          calls.push("cleanup-project");
          return Promise.reject(new CliHomeDisposeError({ cause: permissionError() }));
        },
      });

      yield* drain(manager);

      expect(calls).toEqual(["cleanup-project", "docker-remove"]);
    }),
  );

  it.effect("removes permission-blocked associated homes with the Docker root fallback", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const manager = createStackE2eCleanupManager(
        cleanupEnvironment(calls, {
          removeProjectWithDocker: () => {
            calls.push("docker-remove");
            return Promise.resolve(true);
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
        cleanup: () => {
          calls.push("cleanup-project");
          return Promise.resolve();
        },
      });
      manager.associateHome("/tmp/project", "/tmp/home");

      expect(yield* drain(manager)).toBeUndefined();

      expect(calls).toEqual(["cleanup-project", "dispose-home", "docker-remove"]);
    }),
  );

  it.effect("warns when an associated home remains after permission fallback", () =>
    Effect.gen(function* () {
      const warn = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(console, "warn").mockImplementation(() => {})),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
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
        cleanup: () => {
          calls.push("cleanup-project");
          return Promise.resolve();
        },
      });
      manager.associateHome("/tmp/project", "/tmp/home");

      expect(yield* drain(manager)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to remove temp home"));
      expect(calls).toEqual([
        "cleanup-project",
        "dispose-home",
        "docker-remove",
        "chmod",
        "dispose-home",
      ]);
    }),
  );

  it.effect("disposes an associated home once after all projects sharing it are cleaned", () =>
    Effect.gen(function* () {
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
        cleanup: () => {
          calls.push("cleanup-project-one");
          return Promise.resolve();
        },
      });
      manager.registerStackProject({
        dir: "/tmp/project-two",
        cleanup: () => {
          calls.push("cleanup-project-two");
          return Promise.resolve();
        },
      });
      manager.associateHome("/tmp/project-one", "/tmp/home");
      manager.associateHome("/tmp/project-two", "/tmp/home");

      yield* drain(manager);

      expect(calls).toEqual(["cleanup-project-one", "cleanup-project-two", "dispose-home"]);
    }),
  );

  it.effect("falls back to chmod and retries cleanup when Docker cannot remove the project", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let attempts = 0;
      const manager = createStackE2eCleanupManager(cleanupEnvironment(calls));

      manager.registerStackProject({
        dir: "/tmp/project",
        cleanup: () => {
          attempts += 1;
          calls.push(`cleanup-project:${attempts}`);
          if (attempts === 1) {
            return Promise.reject(permissionError());
          }
          return Promise.resolve();
        },
      });

      yield* drain(manager);

      expect(calls).toEqual(["cleanup-project:1", "docker-remove", "chmod", "cleanup-project:2"]);
    }),
  );

  it.effect(
    "warns with permission diagnostics when fallback cleanup still cannot remove the project",
    () =>
      Effect.gen(function* () {
        const warn = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(console, "warn").mockImplementation(() => {})),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const calls: Array<string> = [];
        const manager = createStackE2eCleanupManager(cleanupEnvironment(calls));

        manager.registerStackProject({
          dir: "/tmp/project",
          cleanup: () => {
            calls.push("cleanup-project");
            return Promise.reject(permissionError());
          },
        });

        expect(yield* drain(manager)).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Permission diagnostics:"));
        expect(calls).toEqual(["cleanup-project", "docker-remove", "chmod", "cleanup-project"]);
      }),
  );
});
