import { NodeHttpClient, NodeServices } from "@effect/platform-node";
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
  Option,
  Path,
  PlatformError,
  Ref,
  Schema,
  Scheduler,
  Scope,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- synchronous existence check between manual scheduler steps.
import { existsSync } from "node:fs";
import { create, discover } from "../effect.ts";
import { destroyTestStack } from "../../tests/stack-cleanup.ts";
import { errorCode } from "./Capabilities.ts";
import * as StackNamespace from "../StackNamespace.ts";

const makeTestState = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );

const initial: StackNamespace.SavedStack = {
  id: "stack-main",
  identity: {
    projectRoot: "/tmp/project",
    branchContext: "main",
    stackName: "local",
  },
  runtime: "docker",
  instances: [],
  lifetime: "detached",
  composition: { members: [], dependencies: [] },
  ports: [],
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const stackLayer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

describe("durable registry", () => {
  it.live("reopens saved state and serializes concurrent read-modify-write operations", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-registry-" });
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
                  { id, creation: { service: "mail", config: {} } },
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
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-registry-invalid-" });
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
        expect(Schema.is(StackNamespace.SavedStack)(valid)).toBe(true);
      }),
    ),
  );

  const listingWithReadFailures = (options: {
    readonly root: string;
    readonly platform: NodeJS.Platform;
    readonly code: string;
    readonly failures: number;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = (yield* Path.Path).join(options.root, initial.id, "state.json");
      const remaining = yield* Ref.make(options.failures);
      const firstFailure = yield* Deferred.make<void>();
      const reported = yield* Ref.make<ReadonlyArray<string>>([]);
      const injectedFs = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        readFileString: (file: string, encoding?: string) =>
          Effect.gen(function* () {
            if (file === target && (yield* Ref.get(remaining)) > 0) {
              yield* Ref.update(remaining, (count) => count - 1);
              yield* Deferred.succeed(firstFailure, undefined);
              return yield* PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readFile",
                pathOrDescriptor: file,
                cause: Object.assign(new Error("injected read failure"), { code: options.code }),
              });
            }
            return yield* fs.readFileString(file, encoding);
          }),
      });
      const store = yield* Layer.build(
        StackNamespace.layer({
          root: options.root,
          platform: options.platform,
          onInvalidState: (id) => Ref.update(reported, (ids) => [...ids, id]),
        }).pipe(Layer.provide(injectedFs)),
      ).pipe(Effect.map((context) => Context.get(context, StackNamespace.Service)));
      return { store, firstFailure, reported };
    });

  it.effect("lists a stack after a transient Windows read failure clears", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "namespace-registry-list-retry-",
        });
        yield* (yield* makeTestState(root)).save(initial);
        const { store, firstFailure, reported } = yield* listingWithReadFailures({
          root,
          platform: "win32",
          code: "EBUSY",
          failures: 1,
        });

        const listing = yield* store.list.pipe(Effect.forkScoped);
        yield* Deferred.await(firstFailure);
        yield* TestClock.adjust("10 millis");
        expect((yield* Fiber.join(listing)).map(({ id }) => id)).toEqual([initial.id]);
        expect(yield* Ref.get(reported)).toEqual([]);
      }),
    ),
  );

  it.effect("skips and reports a stack whose state stays unreadable after retries", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const [platform, code] of [
          ["win32", "EBUSY"],
          ["linux", "EACCES"],
        ] as const) {
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "namespace-registry-list-skip-",
          });
          yield* (yield* makeTestState(root)).save(initial);
          const { store, firstFailure, reported } = yield* listingWithReadFailures({
            root,
            platform,
            code,
            failures: Number.POSITIVE_INFINITY,
          });

          const listing = yield* store.list.pipe(Effect.forkScoped);
          yield* Deferred.await(firstFailure);
          yield* TestClock.adjust("950 millis");
          expect(yield* Fiber.join(listing)).toEqual([]);
          expect(yield* Ref.get(reported)).toEqual([initial.id]);
        }
      }),
    ),
  );

  it.live.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "lists and claims readable stacks past a sibling directory it cannot access",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-registry-eacces-" });
          const reported: Array<string> = [];
          const store = yield* Layer.build(
            StackNamespace.layer({
              root,
              onInvalidState: (id) => Effect.sync(() => reported.push(id)),
            }),
          ).pipe(Effect.map((context) => Context.get(context, StackNamespace.Service)));
          yield* store.save(initial);
          const locked = path.join(root, "locked");
          yield* fs.makeDirectory(locked, { mode: 0o700 });
          yield* fs.writeFileString(path.join(locked, "state.json"), "{}");
          yield* Effect.acquireRelease(fs.chmod(locked, 0o000), () =>
            fs.chmod(locked, 0o700).pipe(Effect.orDie),
          );

          expect((yield* store.list).map(({ id }) => id)).toEqual([initial.id]);
          expect(reported).toEqual(["locked"]);
          expect((yield* store.claims).map(({ id }) => id)).toEqual([initial.id]);
        }),
      ),
  );

  it.live("skips and reports malformed, mismatched, and non-file entries while listing", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "namespace-registry-list-invalid-",
        });
        const reported: Array<string> = [];
        const store = yield* Layer.build(
          StackNamespace.layer({
            root,
            onInvalidState: (id) => Effect.sync(() => reported.push(id)),
          }),
        ).pipe(Effect.map((context) => Context.get(context, StackNamespace.Service)));
        yield* store.save(initial);
        yield* fs.makeDirectory(path.join(root, "malformed"));
        yield* fs.writeFileString(path.join(root, "malformed", "state.json"), "{broken");
        yield* fs.makeDirectory(path.join(root, "mismatched"));
        yield* fs.writeFileString(
          path.join(root, "mismatched", "state.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(StackNamespace.SavedStack))(initial),
        );
        yield* fs.makeDirectory(path.join(root, "directory", "state.json"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "stray-file"), "");

        expect((yield* store.list).map(({ id }) => id)).toEqual([initial.id]);
        // Windows resolves a path below a regular file as missing rather than unreadable.
        expect(reported.toSorted()).toEqual(
          process.platform === "win32"
            ? ["directory", "malformed", "mismatched"]
            : ["directory", "malformed", "mismatched", "stray-file"],
        );
      }),
    ),
  );

  it.live("decodes saved compositions, creations, and instance ids strictly", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-registry-typed-" });
        const reported: Array<string> = [];
        const store = yield* Layer.build(
          StackNamespace.layer({
            root,
            onInvalidState: (id) => Effect.sync(() => reported.push(id)),
          }),
        ).pipe(Effect.map((context) => Context.get(context, StackNamespace.Service)));
        yield* store.save(initial);
        const mail = { service: "mail", config: {} };
        const invalid = {
          "bad-composition": { composition: { members: "none", dependencies: [] } },
          "bad-creation": { instances: [{ id: "one", creation: { service: "unknown" } }] },
          "duplicate-ids": {
            instances: [
              { id: "one", creation: mail },
              { id: "one", creation: mail },
            ],
          },
        };
        for (const [id, override] of Object.entries(invalid)) {
          yield* fs.makeDirectory(path.join(root, id));
          yield* fs.writeFileString(
            path.join(root, id, "state.json"),
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              ...initial,
              id,
              ...override,
            }),
          );
        }

        expect((yield* store.list).map(({ id }) => id)).toEqual([initial.id]);
        expect(reported.toSorted()).toEqual(Object.keys(invalid));
        for (const id of Object.keys(invalid)) {
          const failure = yield* store.read(id).pipe(Effect.flip);
          expect(failure.operation).toBe("decode");
          expect(failure.message).toContain("Unable to decode state");
          expect(failure.message).toContain(`for stack ${id}`);
        }
        const duplicate = yield* store.read("duplicate-ids").pipe(Effect.flip);
        expect(duplicate.message).toContain("Expected unique instance ids");
      }),
    ),
  );

  it.live("removes empty stack parents without deleting unowned data", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-registry-remove-" });
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
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "namespace-registry-traverse-",
          });
          yield* fs.chmod(root, 0o755);
          yield* makeTestState(root);
          expect((yield* fs.stat(root)).mode & 0o777).toBe(0o701);
        }),
      ),
  );
});

describe("registry lock", () => {
  it.effect("keeps a lock owner protected when a waiting fiber is cancelled", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lock-cancel-" });
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
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lock-timeout-" });
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
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lock-failure-" });
        const state = yield* makeTestState(root);
        const failure = new StackNamespace.NamespaceError({
          operation: "test",
          message: "body failed",
        });
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
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lock-invalid-" });
        const state = yield* makeTestState(root);
        yield* fs.writeFileString(`${root}/.registry-lock.sqlite`, "not a database");
        const error = yield* state.withLock(state.save(initial)).pipe(Effect.flip);
        expect(error).toBeInstanceOf(StackNamespace.NamespaceError);
        expect(error.operation).toBe("lock");
        expect(yield* state.read(initial.id)).toBeUndefined();
      }),
    ),
  );

  it.live(
    "releases the lock when the holder is interrupted right after taking it, before the caller body runs",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lock-interrupt-" });
          const first = yield* makeTestState(root);
          const second = yield* makeTestState(root);
          const lockPath = `${root}/.registry-lock.sqlite`;
          const started = yield* Deferred.make<void>();

          // Yielding after every single fiber step, and only resuming a step once flushed, gives
          // deterministic single-step control over the forked fiber below, with no production seam.
          const tasks: Array<() => void> = [];
          const dispatcher: Scheduler.SchedulerDispatcher = {
            scheduleTask: (task) => tasks.push(task),
            flush: () => {
              for (const task of tasks.splice(0, tasks.length)) task();
            },
          };
          const stepScheduler: Scheduler.Scheduler = {
            executionMode: "async",
            shouldYield: (fiber) => fiber.currentOpCount >= fiber.maxOpsBeforeYield,
            makeDispatcher: () => dispatcher,
          };

          const holder = yield* first
            .withLock(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
            .pipe(
              Effect.provideService(Scheduler.Scheduler, stepScheduler),
              Effect.provideService(Scheduler.MaxOpsBeforeYield, 10),
              Effect.forkScoped,
            );
          // The fork itself is scheduled on the default scheduler; let it actually start (handing
          // control to `stepScheduler`) before single-stepping it below.
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          // Single-step the acquisition until the lock file exists on disk, then stop: this always
          // lands in the gap between "lock taken" and "the caller body starts" that the fix closes.
          for (let step = 0; step < 20_000 && !existsSync(lockPath); step++) dispatcher.flush();
          expect(existsSync(lockPath)).toBe(true);
          expect(holder.pollUnsafe()).toBeUndefined();
          expect(Option.isNone(yield* Deferred.poll(started))).toBe(true);

          // Interrupting and resuming through the same controlled dispatcher keeps the whole
          // sequence deterministic: no real scheduler or timer is involved on either side.
          holder.interruptUnsafe();
          for (let step = 0; step < 20_000 && holder.pollUnsafe() === undefined; step++)
            dispatcher.flush();
          expect(holder.pollUnsafe()).not.toBeUndefined();

          // No contention wait: a leaked lock would make this block for up to 5 seconds.
          yield* second.withLock(second.save(initial)).pipe(Effect.timeout("200 millis"));
          expect(yield* second.read(initial.id)).toEqual(initial);
        }),
      ),
  );
});

describe("stack owner lease", () => {
  it.live("hands the lease of a removed stack to a waiter on a live lease file", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lease-handoff-" });
        const holder = yield* makeTestState(root);
        const contended = yield* Deferred.make<void>();
        const waiter = Context.get(
          yield* Layer.build(
            StackNamespace.layer({
              root,
              onLeaseContended: () => Deferred.succeed(contended, undefined).pipe(Effect.asVoid),
            }),
          ),
          StackNamespace.Service,
        );
        const observer = yield* makeTestState(root);
        const holderScope = yield* Scope.make();
        const holderLease = yield* holder.acquireLease("gone").pipe(Scope.provide(holderScope));
        expect(holderLease.stackId).toBe("gone");

        const waiterScope = yield* Scope.make();
        const waiting = yield* waiter
          .acquireLease("gone")
          .pipe(Scope.provide(waiterScope), Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(contended);
        yield* Scope.close(holderScope, Exit.void);

        expect((yield* Fiber.join(waiting)).stackId).toBe("gone");
        expect(yield* observer.leased("gone"), "the path names the file the waiter locked").toBe(
          true,
        );
        yield* Scope.close(waiterScope, Exit.void);
        expect(yield* observer.leased("gone")).toBe(false);
        expect(yield* fs.exists(`${root}/gone`), "the last holder removes the directory").toBe(
          false,
        );
      }),
    ),
  );

  it.live("fails a second owner with a typed error while the first still holds the lease", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lease-held-" });
        const holder = yield* makeTestState(root);
        const contender = yield* makeTestState(root);
        const holderScope = yield* Scope.make();
        yield* holder.acquireLease("busy").pipe(Scope.provide(holderScope));

        const rejection = yield* contender.acquireLease("busy").pipe(Effect.scoped, Effect.flip);
        expect(Schema.is(StackNamespace.LeaseHeldError)(rejection)).toBe(true);
        if (!Schema.is(StackNamespace.LeaseHeldError)(rejection))
          return yield* Effect.die(rejection);
        expect(rejection.stackId).toBe("busy");

        yield* Scope.close(holderScope, Exit.void);
      }),
    ),
  );

  it.live("rejects mutations from a handle whose scope already closed", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lease-expired-" });
        const state = yield* makeTestState(root);
        const firstScope = yield* Scope.make();
        const expired = yield* state.acquireLease("recycled").pipe(Scope.provide(firstScope));
        yield* Scope.close(firstScope, Exit.void);

        const secondScope = yield* Scope.make();
        const live = yield* state.acquireLease("recycled").pipe(Scope.provide(secondScope));
        yield* live.publishHolder({
          role: "sweeper",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        });

        const publishRejected = yield* expired
          .publishHolder({
            role: "sweeper",
            pid: process.pid,
            startedAt: "2026-01-01T00:00:00.000Z",
          })
          .pipe(Effect.flip);
        expect(publishRejected).toBeInstanceOf(StackNamespace.NamespaceError);
        const retractRejected = yield* expired.retractHolder.pipe(Effect.flip);
        expect(retractRejected).toBeInstanceOf(StackNamespace.NamespaceError);

        expect(yield* state.readHolder("recycled")).toEqual({
          role: "sweeper",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        });
        yield* Scope.close(secondScope, Exit.void);
      }),
    ),
  );

  it.live(
    "keeps a fresh holder's record intact against a publish already in flight when its scope closes",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const id = "racing";
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lease-race-" });
          const ownerJson = path.join(root, id, "owner.json");
          // A's publish pauses here, already past the closed-handle guard, so the scope-closing
          // finalizer below can only proceed once A's publish has fully released the gate.
          const paused = yield* Deferred.make<void>();
          const entered = yield* Deferred.make<void>();
          const renameCalls = yield* Ref.make(0);
          const pausingFs = Layer.effect(
            FileSystem.FileSystem,
            Effect.sync(() => ({
              ...fs,
              rename: (oldPath: string, newPath: string) =>
                Effect.gen(function* () {
                  const isFirst =
                    newPath === ownerJson &&
                    (yield* Ref.getAndUpdate(renameCalls, (n) => n + 1)) === 0;
                  if (isFirst) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(paused);
                  }
                  return yield* fs.rename(oldPath, newPath);
                }),
            })),
          );
          const state = Context.get(
            yield* Layer.build(StackNamespace.layer({ root }).pipe(Layer.provide(pausingFs))),
            StackNamespace.Service,
          );

          const scopeA = yield* Scope.make();
          const a = yield* state.acquireLease(id).pipe(Scope.provide(scopeA));
          const recordA: StackNamespace.LeaseHolder = {
            role: "sweeper",
            pid: process.pid,
            startedAt: "2026-01-01T00:00:00.000Z",
          };
          const publishingA = yield* a.publishHolder(recordA).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);

          const closingA = yield* Scope.close(scopeA, Exit.void).pipe(Effect.forkScoped);
          const recordB: StackNamespace.LeaseHolder = {
            role: "sweeper",
            pid: process.pid + 1,
            startedAt: "2026-01-01T00:00:01.000Z",
          };
          const acquiringB = yield* Effect.scoped(
            Effect.gen(function* () {
              const b = yield* state.acquireLease(id);
              yield* b.publishHolder(recordB);
            }),
          ).pipe(Effect.forkScoped);

          // Neither A's close nor B's acquisition can complete while A's publish is paused.
          yield* Effect.sleep("50 millis");
          expect(closingA.pollUnsafe()).toBeUndefined();
          expect(acquiringB.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(paused, undefined);
          yield* Fiber.join(publishingA);
          yield* Fiber.join(closingA);
          yield* Fiber.join(acquiringB);

          expect(yield* state.readHolder(id)).toEqual(recordB);
        }),
      ),
  );

  it.live(
    "keeps a fresh holder's record intact against an interrupted removal whose native callback is still pending",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const id = "racing-interrupt";
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "namespace-lease-race-interrupt-",
          });
          const ownerJson = path.join(root, id, "owner.json");
          const entered = yield* Deferred.make<void>();
          const fire = yield* Deferred.make<void>();
          // Settles once the background removal below has actually run, independent of whether
          // anything is still listening for its `resume` call: proves the real filesystem effect,
          // not just the Effect-level interrupt, has finished before the test checks final state.
          const settled = yield* Deferred.make<void>();
          // Only A's own removal (the first call) is held pending; B's later, unrelated calls on
          // the same path (its own stale-record cleanup, then its own eventual retraction) must
          // pass straight through, or they would deadlock on the very same native callback.
          let intercepted = false;
          const context = yield* Effect.context<FileSystem.FileSystem>();
          const runFork = Effect.runForkWith(context);
          // Mirrors `Effect.effectify(fs.rm)`: no cleanup effect is returned, so interrupting the
          // fiber waiting on this callback only stops listening for it. The real removal, once
          // started in the background below, keeps running and completes on its own regardless.
          const callbackFs = Layer.succeed(FileSystem.FileSystem, {
            ...fs,
            remove: (file: string, options?: Parameters<FileSystem.FileSystem["remove"]>[1]) =>
              file === ownerJson && !intercepted
                ? Effect.callback<void, PlatformError.PlatformError>((resume) => {
                    intercepted = true;
                    Deferred.doneUnsafe(entered, Exit.void);
                    runFork(
                      Deferred.await(fire).pipe(
                        Effect.andThen(fs.remove(file, options)),
                        Effect.matchEffect({
                          onSuccess: () => Effect.sync(() => resume(Effect.void)),
                          onFailure: (cause) => Effect.sync(() => resume(Effect.fail(cause))),
                        }),
                        Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(settled, Exit.void))),
                      ),
                    );
                  })
                : fs.remove(file, options),
          });
          const state = Context.get(
            yield* Layer.build(StackNamespace.layer({ root }).pipe(Layer.provide(callbackFs))),
            StackNamespace.Service,
          );

          const scopeA = yield* Effect.acquireRelease(Scope.make(), (s) =>
            Scope.close(s, Exit.void),
          );
          const a = yield* state.acquireLease(id).pipe(Scope.provide(scopeA));

          // Runs this one fiber with scheduler yields prevented, so it executes synchronously up
          // to the intercepted callback above: by the time this call returns, `entered` is
          // already done, which is what makes the steps below a deterministic barrier instead of
          // a timing guess.
          const mutationContext = Context.add(context, Scheduler.PreventSchedulerYield, true);
          const retracting = Effect.runForkWith(mutationContext)(a.retractHolder);
          yield* Deferred.await(entered);
          yield* Effect.acquireUseRelease(
            Effect.void,
            () =>
              Effect.sync(() => {
                retracting.interruptUnsafe();
                // Without `Effect.uninterruptible` around the guarded mutation, this interrupt
                // unwinds synchronously right here, releasing the gate before the native removal
                // below ever runs; with it, the fiber stays suspended until the release phase
                // lets the callback fire.
                expect(retracting.pollUnsafe()).toBeUndefined();
              }),
            () =>
              Deferred.succeed(fire, undefined).pipe(
                Effect.andThen(Fiber.await(retracting)),
                Effect.andThen(Deferred.await(settled)),
              ),
          );
          yield* Scope.close(scopeA, Exit.void);

          const recordB: StackNamespace.LeaseHolder = {
            role: "sweeper",
            pid: process.pid + 1,
            startedAt: "2026-01-01T00:00:01.000Z",
          };
          const b = yield* state.acquireLease(id);
          yield* b.publishHolder(recordB);

          expect(yield* state.readHolder(id)).toEqual(recordB);
        }),
      ),
  );

  it.live("reports a free lease without creating a lease file", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lease-probe-" });
        const state = yield* makeTestState(root);
        yield* state.save(initial);
        expect(yield* state.leased(initial.id)).toBe(false);
        expect(yield* state.readHolder(initial.id), "a retracted record reads as absent").toBe(
          undefined,
        );
        expect(yield* fs.exists(`${root}/${initial.id}/owner.lock`)).toBe(false);
      }),
    ),
  );

  it.effect("retries a transient holder-read failure and then succeeds", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-holder-read-retry-" });
        const target = path.join(root, initial.id, "owner.json");
        const firstFailure = yield* Deferred.make<void>();
        const failed = yield* Ref.make(false);
        const flakyFs = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file: string, encoding?: string) =>
            Effect.gen(function* () {
              if (file === target && !(yield* Ref.get(failed))) {
                yield* Ref.set(failed, true);
                yield* Deferred.succeed(firstFailure, undefined);
                return yield* PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "readFile",
                  pathOrDescriptor: file,
                  cause: Object.assign(new Error("injected transient read failure"), {
                    code: "EBUSY",
                  }),
                });
              }
              return yield* fs.readFileString(file, encoding);
            }),
        });
        const state = Context.get(
          yield* Layer.build(
            StackNamespace.layer({ root, platform: "win32" }).pipe(Layer.provide(flakyFs)),
          ),
          StackNamespace.Service,
        );
        yield* state.save(initial);
        const scope = yield* Scope.make();
        const lease = yield* state.acquireLease(initial.id).pipe(Scope.provide(scope));
        const record: StackNamespace.LeaseHolder = {
          role: "sweeper",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        };
        yield* lease.publishHolder(record);

        const reading = yield* state.readHolder(initial.id).pipe(Effect.forkScoped);
        yield* Deferred.await(firstFailure);
        yield* TestClock.adjust("10 millis");
        expect(yield* Fiber.join(reading)).toEqual(record);
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.live("publishes successfully despite a transient rename failure", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const id = "flaky-cleanup";
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-publish-cleanup-" });
        const stackDirectory = path.join(root, id);
        const ownerJson = path.join(stackDirectory, "owner.json");
        // A single ignored attempt (the pre-fix behavior) only ever makes one call per site;
        // three consecutive failures need a real retry loop to still converge.
        const remaining = yield* Ref.make(3);
        const flakyFs = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          rename: (oldPath: string, newPath: string) =>
            Effect.gen(function* () {
              if (newPath === ownerJson && (yield* Ref.get(remaining)) > 0) {
                yield* Ref.update(remaining, (count) => count - 1);
                return yield* PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: newPath,
                  cause: Object.assign(new Error("injected transient rename failure"), {
                    code: "EBUSY",
                  }),
                });
              }
              return yield* fs.rename(oldPath, newPath);
            }),
        });
        const state = Context.get(
          yield* Layer.build(
            StackNamespace.layer({ root, platform: "win32" }).pipe(Layer.provide(flakyFs)),
          ),
          StackNamespace.Service,
        );
        const scope = yield* Scope.make();
        const lease = yield* state.acquireLease(id).pipe(Scope.provide(scope));
        const record: StackNamespace.LeaseHolder = {
          role: "sweeper",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        };
        yield* lease.publishHolder(record);

        expect(yield* Ref.get(remaining), "all injected failures were consumed").toBe(0);
        expect(yield* state.readHolder(id)).toEqual(record);
        expect(
          (yield* fs.readDirectory(stackDirectory)).filter((entry) => entry.endsWith(".tmp")),
        ).toEqual([]);
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.live("never reports a holder record missing while replacing it with a fresh one", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const id = "atomic-replace";
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-lease-atomic-" });
        const ownerJson = path.join(root, id, "owner.json");
        const gate = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        // Only the second publish (the replacement) is gated; the first establishes R1 normally.
        let publishCount = 0;
        const gatedFs = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          rename: (oldPath: string, newPath: string) => {
            if (newPath !== ownerJson) return fs.rename(oldPath, newPath);
            publishCount++;
            return publishCount === 2
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(fs.rename(oldPath, newPath)),
                )
              : fs.rename(oldPath, newPath);
          },
        });
        const state = Context.get(
          yield* Layer.build(StackNamespace.layer({ root }).pipe(Layer.provide(gatedFs))),
          StackNamespace.Service,
        );
        const scope = yield* Scope.make();
        const lease = yield* state.acquireLease(id).pipe(Scope.provide(scope));
        const r1: StackNamespace.LeaseHolder = {
          role: "sweeper",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        };
        yield* lease.publishHolder(r1);
        expect(yield* state.readHolder(id)).toEqual(r1);

        const r2: StackNamespace.LeaseHolder = {
          role: "sweeper",
          pid: process.pid + 1,
          startedAt: "2026-01-01T00:00:01.000Z",
        };
        const publishing = yield* lease.publishHolder(r2).pipe(Effect.forkScoped);
        // Runs before the publisher's interruption (reverse order), so a failed assertion can't
        // leave the uninterruptible publish blocked on the gate during teardown.
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        yield* Deferred.await(entered);

        // At the publication gate (the rename not yet landed), a reader must still see the prior
        // record, never a gap: a remove-then-publish sequence would briefly have no file at all.
        expect(yield* state.readHolder(id)).toEqual(r1);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(publishing);
        expect(yield* state.readHolder(id)).toEqual(r2);
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );
});

describe("discovery", () => {
  it.live("lists identical stack identities under two state roots independently", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-discover-" });
      const projectRoot = `${base}/project`;
      yield* fs.makeDirectory(projectRoot, { recursive: true });
      const locations = (root: string) =>
        ({
          projectRoot,
          stateRoot: `${base}/${root}/state`,
          cacheRoot: `${base}/${root}/cache`,
          runtime: "native",
        }) satisfies Parameters<typeof create>[0];
      const a = yield* create(locations("a"));
      const b = yield* create(locations("b"));
      expect(a.id).toBe(b.id);

      const listedA = yield* discover({ stateRoot: `${base}/a/state` });
      const listedB = yield* discover({ stateRoot: `${base}/b/state` });
      expect(listedA.map(({ definition }) => definition.id)).toEqual([a.id]);
      expect(listedB.map(({ definition }) => definition.id)).toEqual([b.id]);

      yield* destroyTestStack(a);
      yield* destroyTestStack(b);
    }).pipe(Effect.scoped, Effect.provide(stackLayer)),
  );
});

describe("publication", () => {
  // Windows has no directory fsync to fail.
  it.effect.skipIf(process.platform === "win32")(
    "fails publication when the directory fsync reports EIO",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const eio = (method: string, file: string) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method,
              pathOrDescriptor: file,
              cause: Object.assign(new Error("injected directory fsync failure"), { code: "EIO" }),
            });
          // Covers both ways opening the directory for its own fsync can report EIO: the `open`
          // call itself failing, and `open` succeeding but the handle's own `sync` failing. The
          // second case is backed by a real regular-file handle (scoped like any other), not the
          // real directory: opening a directory for `sync` hits Windows's own supported `EISDIR`
          // path instead of ever reaching the injected failure.
          for (const mode of ["open", "sync"] as const) {
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-fsync-eio-" });
            const directory = path.join(root, initial.id);
            const syncProbe = path.join(root, ".sync-probe");
            yield* fs.writeFileString(syncProbe, "");
            const failingFs = Layer.succeed(FileSystem.FileSystem, {
              ...fs,
              open: (file: string, options?: Parameters<FileSystem.FileSystem["open"]>[1]) => {
                if (file !== directory || options?.flag !== "r") return fs.open(file, options);
                if (mode === "open") return Effect.fail(eio("open", file));
                return fs
                  .open(syncProbe, options)
                  .pipe(
                    Effect.map((handle) => ({ ...handle, sync: Effect.fail(eio("fsync", file)) })),
                  );
              },
            });
            const store = yield* Layer.build(
              StackNamespace.layer({ root }).pipe(Layer.provide(failingFs)),
            ).pipe(Effect.map((context) => Context.get(context, StackNamespace.Service)));
            const failure = yield* store.save(initial).pipe(Effect.flip);
            expect(failure, mode).toBeInstanceOf(StackNamespace.NamespaceError);
            expect(failure.operation, mode).toBe("publish");
            expect(errorCode(failure.cause), mode).toBe("EIO");
          }
        }),
      ),
  );

  it.effect("leaves no staging file after a partial write fails with ENOSPC", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-publish-enospc-" });
        const directory = path.join(root, initial.id);
        const stagingPrefix = path.join(directory, ".state.json.");
        const failingFs = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          // A real disk ENOSPC lands after some bytes already reached the file; writing a
          // truncated prefix for real before failing reproduces that instead of never creating it.
          writeFileString: (file: string, content: string, options?: { readonly mode?: number }) =>
            file.startsWith(stagingPrefix)
              ? fs.writeFileString(file, content.slice(0, 1), options).pipe(
                  Effect.andThen(
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "writeFile",
                        pathOrDescriptor: file,
                        cause: Object.assign(new Error("injected partial write failure"), {
                          code: "ENOSPC",
                        }),
                      }),
                    ),
                  ),
                )
              : fs.writeFileString(file, content, options),
        });
        const store = yield* Layer.build(
          StackNamespace.layer({ root }).pipe(Layer.provide(failingFs)),
        ).pipe(Effect.map((context) => Context.get(context, StackNamespace.Service)));
        const failure = yield* store.save(initial).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(StackNamespace.NamespaceError);
        expect(
          (yield* fs.readDirectory(directory)).filter((entry) => entry.endsWith(".tmp")),
        ).toEqual([]);
      }),
    ),
  );
});
