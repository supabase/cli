import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem, Path } from "effect";
import { StateManager, type StackState } from "./StateManager.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<StackState> = {}): StackState {
  return {
    pid: 12345,
    name: "my-project",
    projectDir: "/Users/test/Code/myapp",
    apiPort: 54321,
    dbPort: 54322,
    socketPath: "/Users/test/.supabase/stacks/my-project/daemon.sock",
    startedAt: "2026-03-04T10:00:00Z",
    url: "http://127.0.0.1:54321",
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    publishableKey: "pk_test",
    secretKey: "sk_test",
    anonJwt: "anon_jwt",
    serviceRoleJwt: "service_role_jwt",
    dockerContainerNames: ["supa-postgres-54321"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory FileSystem mock
// ---------------------------------------------------------------------------

function mockFileSystem() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const layer = Layer.succeed(FileSystem.FileSystem, {
    [FileSystem.FileSystem.key]: FileSystem.FileSystem.key,
    exists: (path: string) => Effect.succeed(files.has(path) || dirs.has(path)),
    makeDirectory: (dirPath: string, _opts?: { recursive?: boolean }) =>
      Effect.sync(() => {
        // Add the directory and all parent directories
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
    remove: (rmPath: string, _opts?: { recursive?: boolean }) =>
      Effect.sync(() => {
        for (const key of Array.from(files.keys())) {
          if (key === rmPath || key.startsWith(`${rmPath}/`)) files.delete(key);
        }
        for (const key of Array.from(dirs)) {
          if (key === rmPath || key.startsWith(`${rmPath}/`)) dirs.delete(key);
        }
      }),
  } as unknown as FileSystem.FileSystem);

  return { layer, files, dirs };
}

function mockPath() {
  // Use Node.js path module for test (posix-compatible)
  const nodePath = require("node:path");
  return Layer.succeed(Path.Path, {
    [Path.Path.key]: Path.Path.key,
    ...nodePath,
  } as unknown as Path.Path);
}

function setup() {
  const fsm = mockFileSystem();
  const layer = StateManager.make("/test-home").pipe(
    Layer.provide(Layer.merge(fsm.layer, mockPath())),
  );
  return { layer, files: fsm.files, dirs: fsm.dirs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StateManager", () => {
  describe("write + read round-trip", () => {
    it.live("writes and reads back a state file", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        const state = makeState();
        yield* mgr.write(state);
        const read = yield* mgr.read("my-project");
        expect(read).toEqual(state);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("read", () => {
    it.live("returns StateNotFoundError for missing state", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        const exit = yield* mgr.read("nonexistent").pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain("StateNotFoundError");
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("scan", () => {
    it.live("returns empty array when no stacks exist", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        const result = yield* mgr.scan();
        expect(result).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.live("returns all written states", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState({ name: "project-a", apiPort: 10001 }));
        yield* mgr.write(makeState({ name: "project-b", apiPort: 10002 }));
        const result = yield* mgr.scan();
        expect(result).toHaveLength(2);
        const names = result.map((s) => s.name).sort();
        expect(names).toEqual(["project-a", "project-b"]);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("remove", () => {
    it.live("removes a state directory", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState());
        yield* mgr.remove("my-project");
        const exit = yield* mgr.read("my-project").pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
      }).pipe(Effect.provide(layer));
    });

    it.live("does not fail when removing nonexistent state", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.remove("nonexistent");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("resolve", () => {
    it.live("resolves from exact projectDir match", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState({ projectDir: "/Users/test/Code/myapp" }));
        const result = yield* mgr.resolve("/Users/test/Code/myapp");
        expect(result.name).toBe("my-project");
      }).pipe(Effect.provide(layer));
    });

    it.live("resolves from subdirectory", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState({ projectDir: "/Users/test/Code/myapp" }));
        const result = yield* mgr.resolve("/Users/test/Code/myapp/src/components");
        expect(result.name).toBe("my-project");
      }).pipe(Effect.provide(layer));
    });

    it.live("returns innermost match for nested projects", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState({ name: "outer", projectDir: "/Users/test/Code" }));
        yield* mgr.write(makeState({ name: "inner", projectDir: "/Users/test/Code/myapp" }));
        const result = yield* mgr.resolve("/Users/test/Code/myapp/src");
        expect(result.name).toBe("inner");
      }).pipe(Effect.provide(layer));
    });

    it.live("returns NoRunningStackError when no stacks", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        const exit = yield* mgr.resolve("/some/random/dir").pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain("NoRunningStackError");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live("returns NoRunningStackError when no match walking up", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState({ projectDir: "/Users/test/Code/other" }));
        const exit = yield* mgr.resolve("/Users/test/Code/myapp").pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("isAlive", () => {
    it.live("returns true for current process PID", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        const state = makeState({ pid: process.pid });
        const alive = yield* mgr.isAlive(state);
        expect(alive).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.live("returns false for non-existent PID", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        const state = makeState({ pid: 999999 });
        const alive = yield* mgr.isAlive(state);
        expect(alive).toBe(false);
      }).pipe(Effect.provide(layer));
    });
  });
});
