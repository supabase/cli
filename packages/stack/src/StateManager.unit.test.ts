import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { FileSystem, Path } from "effect";
import {
  InvalidStackMetadataError,
  InvalidStackStateError,
  StateManager,
  projectStateManagerPaths,
  singleStackStateManagerPaths,
  type StackState,
} from "./StateManager.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";
import { stackMetadata } from "./StackMetadata.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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
    rename: (oldPath: string, newPath: string) =>
      Effect.sync(() => {
        const content = files.get(oldPath);
        if (content == null) throw new Error(`File not found: ${oldPath}`);
        files.delete(oldPath);
        files.set(newPath, content);
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
  const layer = StateManager.make(
    projectStateManagerPaths("/test-home", "/Users/test/Code/myapp"),
  ).pipe(Layer.provide(Layer.merge(fsm.layer, mockPath())));
  return { layer, files: fsm.files, dirs: fsm.dirs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StateManager", () => {
  describe("path layout", () => {
    it.live("keeps persistent state and runtime socket in separate roots", () => {
      const fsm = mockFileSystem();
      const layer = StateManager.make(
        singleStackStateManagerPaths(
          "/persist/stacks/my-project",
          "/tmp/supabase/custom",
          "my-project",
        ),
      ).pipe(Layer.provide(Layer.merge(fsm.layer, mockPath())));

      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        expect(mgr.stackDir("my-project")).toBe("/persist/stacks/my-project");
        expect(mgr.dataDir("my-project")).toBe("/persist/stacks/my-project/data");
        expect(mgr.runtimeDir("my-project")).toBe("/tmp/supabase/custom");
        expect(mgr.socketPath("my-project")).toBe("/tmp/supabase/custom/daemon.sock");
      }).pipe(Effect.provide(layer));
    });
  });

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

    it.live("fails with InvalidStackStateError for malformed state files", () => {
      const { layer, files } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        files.set(`${mgr.stackDir("my-project")}/state.json`, "{");

        const exit = yield* mgr.read("my-project").pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(InvalidStackStateError);
          }
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

    it.live("fails with InvalidStackStateError during scans for malformed state files", () => {
      const { layer, files } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState());
        files.set(`${mgr.stackDir("my-project")}/state.json`, "{");

        const exit = yield* mgr.scan().pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(InvalidStackStateError);
          }
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("remove", () => {
    it.live("removes runtime state but keeps durable stack metadata", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState());
        yield* mgr.writeMetadata(
          "my-project",
          stackMetadata({
            ports: DEFAULT_PORTS,
            services: {
              postgres: "17.6.1.081",
              postgrest: "14.5",
              auth: "2.188.0-rc.15",
              realtime: "2.78.10",
              storage: "1.41.8",
              imgproxy: "v3.8.0",
              mailpit: "v1.22.3",
              pgmeta: "0.96.1",
              studio: "2026.03.04-sha-0043607",
              analytics: "1.34.7",
              vector: "0.28.1-alpine",
              pooler: "2.7.4",
            },
          }),
        );
        yield* mgr.remove("my-project");
        const exit = yield* mgr.read("my-project").pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        const metadata = yield* mgr.readMetadata("my-project");
        expect(metadata.ports).toEqual(DEFAULT_PORTS);
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

  describe("deleteStack", () => {
    it.live("removes the entire persisted stack directory", () => {
      const { layer, dirs } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState());
        yield* mgr.writeMetadata(
          "my-project",
          stackMetadata({
            ports: DEFAULT_PORTS,
            services: {
              postgres: "17.6.1.081",
              postgrest: "14.5",
              auth: "2.188.0-rc.15",
              realtime: "2.78.10",
              storage: "1.41.8",
              imgproxy: "v3.8.0",
              mailpit: "v1.22.3",
              pgmeta: "0.96.1",
              studio: "2026.03.04-sha-0043607",
              analytics: "1.34.7",
              vector: "0.28.1-alpine",
              pooler: "2.7.4",
            },
          }),
        );
        yield* mgr.remove("my-project");
        expect(dirs.has(mgr.runtimeDir("my-project"))).toBe(false);
        yield* mgr.deleteStack("my-project");
        expect(yield* mgr.stackExists("my-project")).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live("removes the stack directory after a normal stop left durable files behind", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.write(makeState());
        yield* mgr.writeMetadata(
          "my-project",
          stackMetadata({
            ports: DEFAULT_PORTS,
            services: {
              postgres: "17.6.1.081",
              postgrest: "14.5",
              auth: "2.188.0-rc.15",
              realtime: "2.78.10",
              storage: "1.41.8",
              imgproxy: "v3.8.0",
              mailpit: "v1.22.3",
              pgmeta: "0.96.1",
              studio: "2026.03.04-sha-0043607",
              analytics: "1.34.7",
              vector: "0.28.1-alpine",
              pooler: "2.7.4",
            },
          }),
        );
        yield* mgr.remove("my-project");
        expect(yield* mgr.stackExists("my-project")).toBe(true);
        yield* mgr.deleteStack("my-project");
        expect(yield* mgr.stackExists("my-project")).toBe(false);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("stack metadata", () => {
    it.live("writes and reads back durable stack metadata", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        const metadata = stackMetadata({
          ports: DEFAULT_PORTS,
          services: {
            postgres: "17.6.1.081",
            postgrest: "14.5",
            auth: "2.188.0-rc.15",
            realtime: "2.78.10",
            storage: "1.41.8",
            imgproxy: "v3.8.0",
            mailpit: "v1.22.3",
            pgmeta: "0.96.1",
            studio: "2026.03.04-sha-0043607",
            analytics: "1.34.7",
            vector: "0.28.1-alpine",
            pooler: "2.7.4",
          },
        });
        yield* mgr.writeMetadata("my-project", metadata);
        const readMetadata = yield* mgr.readMetadata("my-project");
        expect(readMetadata).toEqual(metadata);
      }).pipe(Effect.provide(layer));
    });

    it.live("scans durable metadata for all stacks", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.writeMetadata(
          "project-a",
          stackMetadata({
            ports: DEFAULT_PORTS,
            services: {
              postgres: "17.6.1.081",
              postgrest: "14.5",
              auth: "2.188.0-rc.15",
              realtime: "2.78.10",
              storage: "1.41.8",
              imgproxy: "v3.8.0",
              mailpit: "v1.22.3",
              pgmeta: "0.96.1",
              studio: "2026.03.04-sha-0043607",
              analytics: "1.34.7",
              vector: "0.28.1-alpine",
              pooler: "2.7.4",
            },
          }),
        );
        yield* mgr.writeMetadata(
          "project-b",
          stackMetadata({
            ports: {
              ...DEFAULT_PORTS,
              apiPort: 55001,
              dbPort: 55002,
            },
            services: {
              postgres: "17.6.1.081",
              postgrest: "14.5",
              auth: "2.188.0-rc.15",
              realtime: "2.78.10",
              storage: "1.41.8",
              imgproxy: "v3.8.0",
              mailpit: "v1.22.3",
              pgmeta: "0.96.1",
              studio: "2026.03.04-sha-0043607",
              analytics: "1.34.7",
              vector: "0.28.1-alpine",
              pooler: "2.7.4",
            },
          }),
        );

        const metadata = yield* mgr.scanMetadata();
        expect(Array.from(metadata.keys()).sort()).toEqual(["project-a", "project-b"]);
        expect(metadata.get("project-a")?.ports).toEqual(DEFAULT_PORTS);
        expect(metadata.get("project-b")?.ports.apiPort).toBe(55001);
      }).pipe(Effect.provide(layer));
    });

    it.live("fails with InvalidStackMetadataError for malformed metadata files", () => {
      const { layer, files } = setup();
      return Effect.gen(function* () {
        const mgr = yield* StateManager;
        yield* mgr.writeMetadata(
          "my-project",
          stackMetadata({
            ports: DEFAULT_PORTS,
            services: {
              postgres: "17.6.1.081",
              postgrest: "14.5",
              auth: "2.188.0-rc.15",
              realtime: "2.78.10",
              storage: "1.41.8",
              imgproxy: "v3.8.0",
              mailpit: "v1.22.3",
              pgmeta: "0.96.1",
              studio: "2026.03.04-sha-0043607",
              analytics: "1.34.7",
              vector: "0.28.1-alpine",
              pooler: "2.7.4",
            },
          }),
        );
        files.set(`${mgr.stackDir("my-project")}/stack.json`, "{");

        const readExit = yield* mgr.readMetadata("my-project").pipe(Effect.exit);
        expect(Exit.isFailure(readExit)).toBe(true);
        if (Exit.isFailure(readExit)) {
          const error = Cause.findErrorOption(readExit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(InvalidStackMetadataError);
          }
        }

        const scanExit = yield* mgr.scanMetadata().pipe(Effect.exit);
        expect(Exit.isFailure(scanExit)).toBe(true);
        if (Exit.isFailure(scanExit)) {
          const error = Cause.findErrorOption(scanExit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(InvalidStackMetadataError);
          }
        }
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
