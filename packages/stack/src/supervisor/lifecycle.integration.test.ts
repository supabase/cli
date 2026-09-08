import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, FileSystem, Option, Redacted, Ref } from "effect";
import { deriveStackId } from "../identity/Identity.ts";
import {
  StackRuntimeError,
  StackCleanupError,
  StackStateInvalidError,
  StackMustBeStoppedError,
  type StackError,
} from "../public/Errors.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeStackStateStore, type StackStateStore } from "../state/StackStateStore.ts";
import {
  makeLifecycleController,
  type LifecycleBackend,
  type LifecycleInput,
} from "./Lifecycle.ts";

const layer = NodeServices.layer;

const identity = {
  projectRoot: "/tmp/supabase-lifecycle",
  checkoutRoot: "/tmp/supabase-lifecycle",
  workspaceId: "/tmp/supabase-lifecycle",
  checkoutId: "/tmp/supabase-lifecycle",
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "lifecycle",
} as const;

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

interface BackendState {
  readonly calls: Array<string>;
  readonly preflight: Array<LifecycleInput>;
  failPreflight?: boolean;
  failLaunch?: boolean;
  failDestroyData?: boolean;
  failDestroyDataOnce?: boolean;
  failCleanupOnce?: boolean;
  gate?: Deferred.Deferred<void>;
  preflightStarted?: Deferred.Deferred<void>;
  waitBeforeLaunch?: Deferred.Deferred<void>;
  launchMutation?: () => Effect.Effect<void, StackError>;
  failCurrentRead?: Ref.Ref<boolean>;
  stopLaunchStarted?: Deferred.Deferred<void>;
  stopLaunchGate?: Deferred.Deferred<void>;
  startLaunchStarted?: Deferred.Deferred<void>;
  lastLifecycle?: PersistedStackState["desiredLifecycle"];
}

const backend = (state: BackendState): LifecycleBackend => ({
  preflight: (input) =>
    Effect.gen(function* () {
      state.calls.push("preflight");
      state.preflight.push(input);
      if (state.preflightStarted !== undefined)
        yield* Deferred.succeed(state.preflightStarted, undefined);
      if (state.failPreflight) return yield* new StackRuntimeError({ message: "preflight failed" });
      if (state.gate !== undefined) yield* Deferred.await(state.gate);
    }),
  launch: (input) =>
    Effect.gen(function* () {
      state.lastLifecycle = input.state.desiredLifecycle;
      state.calls.push(`launch:${input.state.desiredLifecycle}`);
      if (input.state.desiredLifecycle === "running" && state.startLaunchStarted !== undefined)
        yield* Deferred.succeed(state.startLaunchStarted, undefined);
      if (state.waitBeforeLaunch !== undefined) yield* Deferred.await(state.waitBeforeLaunch);
      if (state.launchMutation !== undefined) yield* state.launchMutation();
      if (state.failLaunch) return yield* new StackRuntimeError({ message: "launch failed" });
    }),
  cleanup: Effect.gen(function* () {
    state.calls.push(`cleanup:${state.lastLifecycle ?? "invalid"}`);
    if (state.failCleanupOnce) {
      state.failCleanupOnce = false;
      return yield* new StackCleanupError({ message: "cleanup failed" });
    }
  }),
  destroyData: Effect.gen(function* () {
    state.calls.push(`destroy-data:${state.lastLifecycle ?? "invalid"}`);
    if (state.failDestroyDataOnce) {
      state.failDestroyDataOnce = false;
      return yield* new StackCleanupError({ message: "destroy-data failed" });
    }
    if (state.failDestroyData)
      return yield* new StackCleanupError({ message: "destroy-data failed" });
  }),
});

const makeFixture = (runtime: StackRuntime = { kind: "native" }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-" });
    const id = yield* deriveStackId(identity);
    const store = yield* makeStackStateStore({ stateRoot: root });
    yield* store.initialize(id, {
      format: "supabase-stack-state-v1",
      identity: { ...identity, stackId: id },
      runtime,
      desiredLifecycle: "unconfigured",
      ports: [],
      privatePorts: [],
      secrets: {},
    });
    const state: BackendState = { calls: [], preflight: [] };
    const persistedStore: StackStateStore = {
      ...store,
      read: (stackId) =>
        Effect.gen(function* () {
          if (state.failCurrentRead !== undefined && (yield* Ref.get(state.failCurrentRead))) {
            yield* Ref.set(state.failCurrentRead, false);
            return yield* new StackStateInvalidError({
              message: "injected current-state read failure",
            });
          }
          return yield* store.read(stackId);
        }),
    };
    const controller = yield* makeLifecycleController({
      stackId: id,
      runtime,
      stateStore: persistedStore,
      backend: backend(state),
    });
    return { id, root, store: persistedStore, state, controller };
  });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(layer));

describe("durable lifecycle controller", () => {
  it.live("commits a complete running definition before reconciling", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const result = yield* fixture.controller.start();
        expect(result.desiredLifecycle).toBe("running");
        expect(result.definition).toBeDefined();
        expect(fixture.state.calls).toEqual(["preflight", "launch:running"]);
        expect(yield* fixture.store.read(fixture.id)).toEqual(result);
      }),
    ),
  );

  it.live("reuses persisted definition for an omitted start", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = yield* fixture.controller.start({ config: { capabilities: { rest: {} } } });
        fixture.state.calls.length = 0;
        const second = yield* fixture.controller.stop();
        expect(second.desiredLifecycle).toBe("stopped");
        fixture.state.calls.length = 0;
        const third = yield* fixture.controller.start();
        expect(third.definition).toEqual(first.definition);
        expect(fixture.state.preflight.at(-1)?.definition).toEqual(first.definition);
      }),
    ),
  );

  it.live("is idempotent for an identical running input", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = yield* fixture.controller.start({ config: { capabilities: { rest: {} } } });
        fixture.state.calls.length = 0;
        const second = yield* fixture.controller.start({ config: { capabilities: { rest: {} } } });
        expect(second).toEqual(first);
        expect(fixture.state.calls).toEqual(["launch:running"]);
      }),
    ),
  );

  it.live("persists stopped when a fresh running session cannot launch", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.controller.start();
        fixture.state.failLaunch = true;

        const failed = yield* fixture.controller.start({ freshSession: true }).pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackRuntimeError);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
        expect(fixture.state.calls.at(-1)).toBe("cleanup:running");
      }),
    ),
  );

  it.live("preserves sticky ports allocated during a failed cold launch", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.state.failLaunch = true;
        fixture.state.launchMutation = () =>
          Effect.provide(
            fixture.store.read(fixture.id).pipe(
              Effect.flatMap((current) =>
                current === undefined
                  ? Effect.fail(new StackStateInvalidError({ message: "state disappeared" }))
                  : fixture.store.replace(fixture.id, {
                      ...current,
                      ports: [{ field: "api", port: 54_321, intent: "automatic" }],
                      privatePorts: [{ workloadId: "rest:rest", binding: "http", port: 54_322 }],
                    }),
              ),
              Effect.asVoid,
            ),
            layer,
          );

        const failed = yield* fixture.controller.start().pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackRuntimeError);
        const stopped = yield* fixture.store.read(fixture.id);
        expect(stopped?.desiredLifecycle).toBe("stopped");
        expect(stopped?.ports).toEqual([{ field: "api", port: 54_321, intent: "automatic" }]);
        expect(stopped?.privatePorts).toEqual([
          { workloadId: "rest:rest", binding: "http", port: 54_322 },
        ]);
      }),
    ),
  );

  it.live("does not write a stale stopped state when current-state read fails", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.state.failLaunch = true;
        const failCurrentRead = yield* Ref.make(false);
        fixture.state.failCurrentRead = failCurrentRead;
        fixture.state.launchMutation = () => Ref.set(failCurrentRead, true);
        const failed = yield* fixture.controller.start().pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackRuntimeError);
        expect(fixture.state.calls).toContain("cleanup:running");
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("running");
      }),
    ),
  );

  it.live("accepts explicit materialized defaults for a running stack", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = yield* fixture.controller.start();
        const second = yield* fixture.controller.start({
          config: { capabilities: { rest: { enabled: true } } },
        });
        expect(second.definition).toEqual(first.definition);
      }),
    ),
  );

  it.live("requires stop before applying pass-through secret changes", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const original = {
          capabilities: {
            functions: {
              settings: {
                functions: { hello: { env: { TOKEN: Redacted.make("one") } } },
              },
            },
          },
        };
        const changed = {
          capabilities: {
            functions: {
              settings: {
                functions: { hello: { env: { TOKEN: Redacted.make("two") } } },
              },
            },
          },
        };
        yield* fixture.controller.start({ config: original });
        const running = yield* fixture.controller.start({ config: changed }).pipe(Effect.exit);
        expect(errorOf(running)).toBeInstanceOf(StackMustBeStoppedError);
        yield* fixture.controller.stop();
        const restarted = yield* fixture.controller.start({ config: changed });
        expect(restarted.desiredLifecycle).toBe("running");
        expect(restarted.secrets).toMatchObject({
          "secret:functions.settings.functions.hello.env.TOKEN": { value: "two" },
        });
      }),
    ),
  );

  it.live("rejects a changed running input before backend mutation", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.controller.start({ config: { capabilities: { rest: {} } } });
        const before = [...fixture.state.calls];
        const exit = yield* fixture.controller
          .start({ config: { capabilities: { rest: { settings: { schemas: ["private"] } } } } })
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(StackMustBeStoppedError);
        expect(fixture.state.calls).toEqual(before);
      }),
    ),
  );

  it.live("retains stopped state and makes stop idempotent", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.controller.start();
        fixture.state.calls.length = 0;
        const first = yield* fixture.controller.stop();
        expect(first.desiredLifecycle).toBe("stopped");
        expect(first.definition).toBeDefined();
        expect(fixture.state.calls).toEqual(["cleanup:running"]);
        fixture.state.calls.length = 0;
        const second = yield* fixture.controller.stop();
        expect(second).toEqual(first);
        expect(fixture.state.calls).toEqual(["cleanup:running"]);
      }),
    ),
  );

  it.live("retries stopped cleanup after a prior cleanup failure", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.controller.start();
        fixture.state.calls.length = 0;
        fixture.state.failCleanupOnce = true;
        const first = yield* fixture.controller.stop().pipe(Effect.exit);
        expect(errorOf(first)).toBeInstanceOf(StackCleanupError);
        const stopped = yield* fixture.store.read(fixture.id);
        expect(stopped?.desiredLifecycle).toBe("stopped");
        fixture.state.calls.length = 0;
        const second = yield* fixture.controller.stop();
        expect(second.desiredLifecycle).toBe("stopped");
        expect(fixture.state.calls).toEqual(["cleanup:running"]);
      }),
    ),
  );

  it.live("leaves old state untouched when preflight fails", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = yield* fixture.controller.start();
        yield* fixture.controller.stop();
        fixture.state.calls.length = 0;
        fixture.state.failPreflight = true;
        const exit = yield* fixture.controller
          .start({ config: { capabilities: { rest: {} } } })
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(StackRuntimeError);
        expect(yield* fixture.store.read(fixture.id)).toMatchObject({
          desiredLifecycle: "stopped",
          definition: first.definition,
        });
        expect(fixture.state.calls).toEqual(["preflight"]);
      }),
    ),
  );

  it.live("destroys runtime data before deleting the exact identity root", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${fixture.root}/${fixture.id}/runtime`, { recursive: true });
        yield* fixture.controller.start();
        fixture.state.calls.length = 0;
        yield* fixture.controller.destroy();
        expect(fixture.state.calls).toEqual(["destroy-data:running"]);
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
        expect(yield* fs.exists(`${fixture.root}/${fixture.id}`)).toBe(false);
        const recreated = yield* fixture.store.initialize(fixture.id, {
          format: "supabase-stack-state-v1",
          identity: { ...identity, stackId: fixture.id },
          runtime: { kind: "native" },
          desiredLifecycle: "unconfigured",
          ports: [],
          privatePorts: [],
          secrets: {},
        });
        expect(recreated.desiredLifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live("retains the destroying fence when data cleanup fails", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.controller.start();
        fixture.state.calls.length = 0;
        fixture.state.failDestroyData = true;
        const exit = yield* fixture.controller.destroy().pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(StackCleanupError);
        expect(yield* fixture.store.read(fixture.id)).toMatchObject({
          desiredLifecycle: "destroying",
        });
        expect(fixture.state.calls).toEqual(["destroy-data:running"]);
        fixture.state.failDestroyData = false;
        yield* fixture.controller.destroy();
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("destroys exact runtime remnants from an unconfigured state", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.controller.destroy();
        expect(fixture.state.calls).toEqual(["destroy-data:invalid"]);
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("retries destructive cleanup after a transient failure", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.state.failDestroyDataOnce = true;
        const first = yield* fixture.controller.destroy().pipe(Effect.exit);
        expect(errorOf(first)).toBeInstanceOf(StackCleanupError);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("destroying");
        yield* fixture.controller.destroy();
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("fails closed when state is missing", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.store.cleanup(fixture.id);
        const exit = yield* fixture.controller.start().pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );
});
