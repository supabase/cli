import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { TestClock } from "effect/testing";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Ref,
  Schema,
} from "effect";
import * as State from "./State.ts";
import type { SavedStack } from "./State.ts";

const makeTestState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

const initial: SavedStack = {
  id: "stack-main",
  identity: {
    projectRoot: "/tmp/project",
    branchContext: "main",
    stackName: "local",
  },
  runtime: "docker",
  instances: [],
  composition: { members: [], dependencies: [] },
  ports: [],
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("durable stack state", () => {
  it.live("reopens saved state and serializes concurrent read-modify-write operations", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-" });
        const first = yield* makeTestState(root);
        const second = yield* makeTestState(root);
        yield* first.save(initial);

        const add = (store: typeof first, id: string) =>
          store.withLock(
            Effect.gen(function* () {
              const current = yield* store.read(initial.id);
              if (current === undefined) return yield* Effect.die("state disappeared");
              yield* store.save({
                ...current,
                instances: [
                  ...current.instances,
                  { id, creation: { service: "database", config: { version: "17" } } },
                ],
              });
            }),
          );
        yield* Effect.all([add(first, "db-one"), add(second, "db-two")], {
          concurrency: "unbounded",
        });

        const reopened = yield* (yield* makeTestState(root)).read(initial.id);
        expect(reopened?.instances.map((instance) => instance.id).sort()).toEqual([
          "db-one",
          "db-two",
        ]);
        expect(yield* fs.stat(path.join(root, "stack-main", "state.json"))).toBeDefined();
      }),
    ),
  );

  it.effect("rejects unsafe paths and malformed documents without changing valid state", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-invalid-" });
        const store = yield* makeTestState(root);
        yield* store.save(initial);
        const unsafe = yield* store.read("../outside").pipe(Effect.exit);
        expect(Exit.isFailure(unsafe)).toBe(true);

        yield* fs.makeDirectory(`${root}/broken`);
        yield* fs.writeFileString(`${root}/broken/state.json`, '{"id":42}');
        const malformed = yield* store.read("broken").pipe(Effect.exit);
        expect(Exit.isFailure(malformed)).toBe(true);
        if (Exit.isFailure(malformed)) {
          expect(String(malformed.cause)).toContain("stack broken");
          expect(String(malformed.cause)).toContain("state.json");
        }
        const valid = yield* store.read(initial.id);
        expect(Schema.is(State.SavedStack)(valid)).toBe(true);
      }),
    ),
  );

  it.effect("reports replacement errno and destination while preserving the prior state", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-state-rename-",
        });
        const renameCalls = yield* Ref.make(0);
        const failRename = yield* Ref.make(false);
        const firstFailure = yield* Deferred.make<void>();
        const injectedFs = Layer.effect(
          FileSystem.FileSystem,
          Effect.succeed({
            ...fs,
            rename: (from: string, to: string) =>
              Ref.updateAndGet(renameCalls, (calls) => calls + 1).pipe(
                Effect.flatMap(() =>
                  Effect.map(Ref.get(failRename), (shouldFail) => ({
                    shouldFail,
                  })),
                ),
                Effect.flatMap(({ shouldFail }) =>
                  shouldFail && from.endsWith("state.json") && to.endsWith("state.json")
                    ? Deferred.succeed(firstFailure, undefined).pipe(
                        Effect.andThen(
                          Effect.fail(
                            PlatformError.systemError({
                              _tag: "Unknown",
                              module: "FileSystem",
                              method: "rename",
                              pathOrDescriptor: to,
                              description: "injected replacement failure",
                              cause: Object.assign(new Error("sharing violation"), {
                                code: "EPERM",
                              }),
                            }),
                          ),
                        ),
                      )
                    : fs.rename(from, to),
                ),
              ),
          }),
        );
        const store = yield* Layer.build(
          State.layer({ root, platform: "win32" }).pipe(Layer.provide(injectedFs)),
        ).pipe(Effect.map((context) => Context.get(context, State.Service)));
        yield* store.save(initial);
        yield* Ref.set(renameCalls, 0);
        yield* Ref.set(failRename, true);
        const saving = yield* store
          .save({
            ...initial,
            identity: { ...initial.identity, stackName: "next" },
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(firstFailure);
        yield* TestClock.adjust("950 millis");
        const error = yield* Fiber.join(saving).pipe(Effect.flip);
        expect(error.operation).toBe("publish");
        expect(error.message).toContain("EPERM");
        expect(error.message).toContain(path.join(root, "stack-main", "state.json"));
        expect(yield* Ref.get(renameCalls)).toBe(13);
        expect(yield* store.read(initial.id)).toEqual(initial);
        expect(
          (yield* fs.readDirectory(root)).some((entry) => entry.startsWith(".state-write-")),
        ).toBe(false);
      }),
    ),
  );

  it.effect("recovers from each Windows replacement errno using the same temporary state", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const code of ["EPERM", "EACCES", "EBUSY"]) {
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: `stack-state-retry-${code}-`,
          });
          const calls = yield* Ref.make(0);
          const temporaryPaths = yield* Ref.make<ReadonlyArray<string>>([]);
          const failOnce = yield* Ref.make(false);
          const firstFailure = yield* Deferred.make<void>();
          const injectedFs = Layer.effect(
            FileSystem.FileSystem,
            Effect.succeed({
              ...fs,
              rename: (from: string, to: string) =>
                Effect.gen(function* () {
                  yield* Ref.update(calls, (count) => count + 1);
                  if (yield* Ref.get(failOnce)) {
                    yield* Ref.set(failOnce, false);
                    yield* Ref.update(temporaryPaths, (paths) => [...paths, from]);
                    yield* Deferred.succeed(firstFailure, undefined);
                    return yield* PlatformError.systemError({
                      _tag:
                        code === "EACCES"
                          ? "PermissionDenied"
                          : code === "EBUSY"
                            ? "Busy"
                            : "Unknown",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to,
                      cause: Object.assign(new Error("sharing violation"), {
                        code,
                      }),
                    });
                  }
                  yield* Ref.update(temporaryPaths, (paths) => [...paths, from]);
                  return yield* fs.rename(from, to);
                }),
            }),
          );
          const store = yield* Layer.build(
            State.layer({ root, platform: "win32" }).pipe(Layer.provide(injectedFs)),
          ).pipe(Effect.map((context) => Context.get(context, State.Service)));
          yield* store.save(initial);
          yield* Ref.set(calls, 0);
          yield* Ref.set(temporaryPaths, []);
          yield* Ref.set(failOnce, true);
          const publishing = yield* store
            .save({
              ...initial,
              identity: { ...initial.identity, stackName: code },
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(firstFailure);
          expect(yield* store.read(initial.id)).toEqual(initial);
          expect(
            (yield* fs.readDirectory(root)).some((entry) => entry.startsWith(".state-write-")),
          ).toBe(true);
          yield* TestClock.adjust("10 millis");
          yield* Fiber.join(publishing);
          expect(yield* Ref.get(calls)).toBe(2);
          const retriedPaths = yield* Ref.get(temporaryPaths);
          expect(retriedPaths).toHaveLength(2);
          expect(retriedPaths[0]).toContain(".state-write-");
          expect(retriedPaths[1]).toBe(retriedPaths[0]);
          expect((yield* store.read(initial.id))?.identity.stackName).toBe(code);
          expect(
            (yield* fs.readDirectory(root)).some((entry) => entry.startsWith(".state-write-")),
          ).toBe(false);
        }
      }),
    ),
  );

  it.effect("does not retry non-Windows or unrelated replacement errors", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const [platform, code] of [
          ["darwin", "EPERM"],
          ["win32", "EINVAL"],
        ] as const) {
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "stack-state-no-retry-",
          });
          const calls = yield* Ref.make(0);
          const injectedFs = Layer.effect(
            FileSystem.FileSystem,
            Effect.succeed({
              ...fs,
              rename: (from: string, to: string) =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.andThen(
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: to,
                        cause: Object.assign(new Error("injected failure"), {
                          code,
                        }),
                      }),
                    ),
                  ),
                ),
            }),
          );
          const store = yield* Layer.build(
            State.layer({ root, platform }).pipe(Layer.provide(injectedFs)),
          ).pipe(Effect.map((context) => Context.get(context, State.Service)));
          const error = yield* store.save(initial).pipe(Effect.flip);
          expect(error.operation).toBe("publish");
          expect(yield* Ref.get(calls)).toBe(1);
          expect(
            (yield* fs.readDirectory(root)).some((entry) => entry.startsWith(".state-write-")),
          ).toBe(false);
        }
      }),
    ),
  );

  it.effect("cleans up a cancelled Windows replacement and releases the state lock", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-state-cancel-rename-",
        });
        const calls = yield* Ref.make(0);
        const failRename = yield* Ref.make(false);
        const firstFailure = yield* Deferred.make<void>();
        const injectedFs = Layer.effect(
          FileSystem.FileSystem,
          Effect.succeed({
            ...fs,
            rename: (from: string, to: string) =>
              Effect.gen(function* () {
                if (from.endsWith("state.json") && to.endsWith("state.json")) {
                  yield* Ref.update(calls, (count) => count + 1);
                  if (yield* Ref.get(failRename)) {
                    yield* Deferred.succeed(firstFailure, undefined);
                    return yield* PlatformError.systemError({
                      _tag: "Busy",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to,
                      cause: Object.assign(new Error("sharing violation"), {
                        code: "EBUSY",
                      }),
                    });
                  }
                }
                return yield* fs.rename(from, to);
              }),
          }),
        );
        const store = yield* Layer.build(
          State.layer({ root, platform: "win32" }).pipe(Layer.provide(injectedFs)),
        ).pipe(Effect.map((context) => Context.get(context, State.Service)));
        yield* store.save(initial);
        yield* Ref.set(calls, 0);
        yield* Ref.set(failRename, true);
        const next = {
          ...initial,
          identity: { ...initial.identity, stackName: "next" },
        };
        const saving = yield* store.withLock(store.save(next)).pipe(Effect.forkScoped);
        yield* Deferred.await(firstFailure);
        yield* TestClock.adjust("1 millis");
        expect(yield* Ref.get(calls)).toBe(1);
        yield* Fiber.interrupt(saving);
        expect(yield* store.read(initial.id)).toEqual(initial);
        expect(
          (yield* fs.readDirectory(root)).some((entry) => entry.startsWith(".state-write-")),
        ).toBe(false);

        yield* Ref.set(failRename, false);
        yield* store.withLock(store.save(next));
        expect((yield* store.read(initial.id))?.identity.stackName).toBe("next");
      }),
    ),
  );

  it.live("removes empty stack parents without deleting unowned data", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-remove-" });
        const store = yield* makeTestState(root);
        yield* store.save(initial);
        yield* fs.makeDirectory(path.join(root, initial.id, "data"), { recursive: true });
        yield* store.remove(initial.id);
        expect(yield* fs.exists(path.join(root, initial.id))).toBe(false);

        yield* store.save(initial);
        yield* fs.makeDirectory(path.join(root, initial.id, "data"), { recursive: true });
        yield* fs.writeFileString(path.join(root, initial.id, "data", "owned-by-caller"), "keep");
        yield* store.remove(initial.id);
        expect(yield* fs.exists(path.join(root, initial.id, "data", "owned-by-caller"))).toBe(true);
      }),
    ),
  );

  it.live.skipIf(process.platform === "win32")(
    "restricts the state root to its owner while keeping a traverse-only grant",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-traverse-" });
          yield* fs.chmod(root, 0o755);
          yield* makeTestState(root);
          expect((yield* fs.stat(root)).mode & 0o777).toBe(0o701);
        }),
      ),
  );

  it.effect("keeps a lock owner protected when a waiting fiber is cancelled", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-lock-" });
        const first = yield* makeTestState(root);
        const second = yield* makeTestState(root);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkScoped(
          first.withLock(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          ),
        );
        yield* Deferred.await(entered);
        const waiter = yield* Effect.forkScoped(second.withLock(second.save(initial)));
        yield* TestClock.adjust("100 millis");
        yield* Fiber.interrupt(waiter);
        expect(yield* second.read(initial.id)).toBeUndefined();
        const later = yield* Effect.forkScoped(second.withLock(second.save(initial)));
        yield* TestClock.adjust("100 millis");
        expect(yield* second.read(initial.id)).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        yield* TestClock.adjust("50 millis");
        yield* Fiber.join(later);
        expect(yield* second.read(initial.id)).toEqual(initial);
      }),
    ),
  );
  it.effect("times out contention without releasing the holder's lock", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-lock-timeout-" });
        const first = yield* makeTestState(root);
        const second = yield* makeTestState(root);
        const entered = yield* Deferred.make<void>();
        const owner = yield* first
          .withLock(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const waiter = yield* second
          .withLock(second.save(initial))
          .pipe(Effect.flip, Effect.forkScoped);
        yield* TestClock.adjust("6 seconds");
        const result = yield* Fiber.join(waiter);
        expect(result.operation).toBe("lock");
        expect(result.message).toBe("Stack registry is locked by another operation; retry shortly");
        expect(yield* second.read(initial.id)).toBeUndefined();
        yield* Fiber.interrupt(owner);
        yield* second.withLock(second.save(initial));
        expect(yield* second.read(initial.id)).toEqual(initial);
      }),
    ),
  );

  it.live("releases ownership after failure and defects without replacing the lock file", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-lock-failure-" });
        const state = yield* makeTestState(root);
        const failure = new State.StateError({ operation: "test", message: "body failed" });
        expect(yield* state.withLock(Effect.fail(failure)).pipe(Effect.flip)).toBe(failure);
        const defect = yield* state.withLock(Effect.die("body defect")).pipe(Effect.exit);
        expect(Exit.hasDies(defect)).toBe(true);
        yield* state.withLock(state.save(initial));
        expect(yield* state.read(initial.id)).toEqual(initial);
        expect((yield* fs.readDirectory(root)).sort()).toEqual([
          ".registry-lock.sqlite",
          initial.id,
        ]);
        expect((yield* fs.stat(`${root}/.registry-lock.sqlite`)).size).toBe(0n);
      }),
    ),
  );
  it.effect("fails invalid lock files without retrying or changing saved state", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-lock-invalid-" });
        const state = yield* makeTestState(root);
        yield* fs.writeFileString(`${root}/.registry-lock.sqlite`, "not a database");
        const error = yield* state.withLock(state.save(initial)).pipe(Effect.flip);
        expect(error).toBeInstanceOf(State.StateError);
        expect(error.operation).toBe("lock");
        expect(yield* state.read(initial.id)).toBeUndefined();
      }),
    ),
  );
});
