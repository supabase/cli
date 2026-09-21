import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Schema } from "effect";
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

  it.live("keeps a lock owner protected when a waiting fiber is cancelled", () =>
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
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiter);
        expect(yield* fs.exists(`${root}/.registry.lock`)).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        yield* second.save(initial);
      }),
    ),
  );
  it.live(
    "releases a registry lock when cancellation arrives before mkdir acknowledges acquisition",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-lock-acquisition-" });
          const lockPath = path.join(root, ".registry.lock");
          const created = yield* Deferred.make<void>();
          const acknowledge = yield* Deferred.make<void>();
          const delayedFs = {
            ...fs,
            makeDirectory: (directory: string, options?: Parameters<typeof fs.makeDirectory>[1]) =>
              fs
                .makeDirectory(directory, options)
                .pipe(
                  Effect.andThen(
                    directory === lockPath
                      ? Deferred.succeed(created, undefined).pipe(
                          Effect.andThen(Deferred.await(acknowledge)),
                        )
                      : Effect.void,
                  ),
                ),
          };
          const store = yield* makeTestState(root).pipe(
            Effect.provideService(FileSystem.FileSystem, delayedFs),
          );
          const operation = yield* store.withLock(Effect.void).pipe(Effect.forkScoped);
          yield* Deferred.await(created);
          yield* Effect.sync(() => {
            operation.interruptUnsafe();
          });
          yield* Deferred.succeed(acknowledge, undefined);
          expect(Exit.hasInterrupts(yield* Fiber.await(operation))).toBe(true);
          expect(yield* fs.exists(lockPath)).toBe(false);
        }),
      ),
  );
});
