import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem, Path } from "effect";
import type { AllocatedPorts } from "./PortAllocator.ts";
import { resolveManagedStack } from "./managed-stack.ts";
import { StateManager, projectStateManagerPaths, type StackState } from "./StateManager.ts";

const DEFAULT_PORTS: AllocatedPorts = {
  apiPort: 54321,
  dbPort: 54322,
  authPort: 54330,
  postgrestPort: 54331,
  postgrestAdminPort: 54332,
  realtimePort: 54333,
  storagePort: 54334,
  imgproxyPort: 54335,
  mailpitPort: 54324,
  mailpitSmtpPort: 54325,
  mailpitPop3Port: 54326,
  pgmetaPort: 54336,
  studioPort: 54323,
  analyticsPort: 54327,
  poolerPort: 54329,
  poolerApiPort: 54337,
};

function makeState(overrides: Partial<StackState> = {}): StackState {
  return {
    pid: 12345,
    name: "my-project",
    projectDir: "/Users/test/Code/myapp",
    apiPort: 54321,
    dbPort: 54322,
    ports: DEFAULT_PORTS,
    socketPath: "/tmp/supabase/s-123456789abc/daemon.sock",
    startedAt: "2026-03-04T10:00:00Z",
    url: "http://127.0.0.1:54321",
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    publishableKey: "pk_test",
    secretKey: "sk_test",
    anonJwt: "anon_jwt",
    serviceRoleJwt: "service_role_jwt",
    serviceEndpoints: {},
    services: {
      postgres: "17.6.1.081",
      auth: "2.188.0-rc.15",
    },
    ...overrides,
  };
}

function mockFileSystem() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const layer = Layer.succeed(FileSystem.FileSystem, {
    [FileSystem.FileSystem.key]: FileSystem.FileSystem.key,
    exists: (path: string) => Effect.succeed(files.has(path) || dirs.has(path)),
    makeDirectory: (dirPath: string) =>
      Effect.sync(() => {
        let current = dirPath;
        while (current && current !== "/") {
          dirs.add(current);
          const parent = require("node:path").dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }),
    readDirectory: (dirPath: string) =>
      Effect.sync(() => {
        const entries: string[] = [];
        const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
        const allKeys = Array.from(files.keys()).concat(Array.from(dirs));
        for (const key of allKeys) {
          if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            const segment = rest.split("/")[0];
            if (segment && !entries.includes(segment)) {
              entries.push(segment);
            }
          }
        }
        return entries;
      }),
    writeFileString: (path: string, content: string) =>
      Effect.sync(() => {
        files.set(path, content);
      }),
    readFileString: (path: string) =>
      Effect.sync(() => {
        const content = files.get(path);
        if (content == null) throw new Error(`File not found: ${path}`);
        return content;
      }),
    remove: (rmPath: string) =>
      Effect.sync(() => {
        for (const key of Array.from(files.keys())) {
          if (key === rmPath || key.startsWith(`${rmPath}/`)) files.delete(key);
        }
        for (const key of Array.from(dirs)) {
          if (key === rmPath || key.startsWith(`${rmPath}/`)) dirs.delete(key);
        }
      }),
    rename: (oldPath: string, newPath: string) =>
      Effect.sync(() => {
        const content = files.get(oldPath);
        if (content == null) throw new Error(`File not found: ${oldPath}`);
        files.delete(oldPath);
        files.set(newPath, content);
      }),
  } as unknown as FileSystem.FileSystem);

  return { layer, files };
}

function mockPath() {
  const nodePath = require("node:path");
  return Layer.succeed(Path.Path, {
    [Path.Path.key]: Path.Path.key,
    ...nodePath,
  } as unknown as Path.Path);
}

function setup() {
  const fsm = mockFileSystem();
  const layer = Layer.merge(fsm.layer, mockPath());
  return { layer, files: fsm.files };
}

const makeStateManager = StateManager.asEffect().pipe(
  Effect.provide(
    StateManager.make(projectStateManagerPaths("/test-home", "/Users/test/Code/myapp")),
  ),
);

describe("resolveManagedStack", () => {
  it.effect("resolves a live stack by explicit name", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const mgr = yield* makeStateManager;
      yield* mgr.write(makeState({ pid: process.pid }));

      const result = yield* resolveManagedStack({
        cacheRoot: "/test-home",
        name: "my-project",
      });

      expect(result.alive).toBe(true);
      expect(result.state.name).toBe("my-project");
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a live stack by cwd walk-up", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const mgr = yield* makeStateManager;
      yield* mgr.write(makeState({ pid: process.pid, projectDir: "/Users/test/Code/myapp" }));

      const result = yield* resolveManagedStack({
        cacheRoot: "/test-home",
        cwd: "/Users/test/Code/myapp/src/components",
      });

      expect(result.alive).toBe(true);
      expect(result.state.projectDir).toBe("/Users/test/Code/myapp");
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the requested named stack within the same project", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const mgr = yield* makeStateManager;
      yield* mgr.write(makeState({ name: "default", pid: 999999 }));
      yield* mgr.write(makeState({ name: "preview", pid: process.pid }));

      const result = yield* resolveManagedStack({
        cacheRoot: "/test-home",
        projectDir: "/Users/test/Code/myapp",
        name: "preview",
      });

      expect(result.alive).toBe(true);
      expect(result.state.name).toBe("preview");
    }).pipe(Effect.provide(layer));
  });

  it.effect("removes stale state for dead stacks", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const mgr = yield* makeStateManager;
      yield* mgr.write(makeState({ pid: 999999 }));

      const result = yield* resolveManagedStack({
        cacheRoot: "/test-home",
        name: "my-project",
      });

      expect(result.alive).toBe(false);
      const readExit = yield* mgr.read("my-project").pipe(Effect.exit);
      expect(readExit._tag).toBe("Failure");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when no stack matches", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* resolveManagedStack({
        cacheRoot: "/test-home",
        cwd: "/Users/test/Code/myapp",
      }).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(layer));
  });
});
