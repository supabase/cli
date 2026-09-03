import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, FileSystem, Option, Redacted } from "effect";
import { deriveStackId } from "../identity/Identity.ts";
import {
  StackReconciliationError,
  StackStateInvalidError,
  StackMustBeStoppedError,
} from "../public/Errors.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
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
  failDestroyData?: boolean;
  failCleanupOnce?: boolean;
  gate?: Deferred.Deferred<void>;
  preflightStarted?: Deferred.Deferred<void>;
  waitBeforeReconcile?: Deferred.Deferred<void>;
  stopReconcileStarted?: Deferred.Deferred<void>;
  stopReconcileGate?: Deferred.Deferred<void>;
  startReconcileStarted?: Deferred.Deferred<void>;
  lastLifecycle?: PersistedStackState["desiredLifecycle"];
}

const backend = (state: BackendState): LifecycleBackend => ({
  preflight: (input) =>
    Effect.gen(function* () {
      state.calls.push("preflight");
      state.preflight.push(input);
      if (state.preflightStarted !== undefined)
        yield* Deferred.succeed(state.preflightStarted, undefined);
      if (state.failPreflight)
        return yield* new StackReconciliationError({ message: "preflight failed" });
      if (state.gate !== undefined) yield* Deferred.await(state.gate);
    }),
  reconcile: (input) =>
    Effect.gen(function* () {
      state.lastLifecycle = input.state.desiredLifecycle;
      state.calls.push(`reconcile:${input.state.desiredLifecycle}`);
      if (input.state.desiredLifecycle === "running" && state.startReconcileStarted !== undefined)
        yield* Deferred.succeed(state.startReconcileStarted, undefined);
      if (input.state.desiredLifecycle === "stopped") {
        if (state.stopReconcileStarted !== undefined)
          yield* Deferred.succeed(state.stopReconcileStarted, undefined);
        if (state.stopReconcileGate !== undefined) yield* Deferred.await(state.stopReconcileGate);
      }
      if (state.waitBeforeReconcile !== undefined) yield* Deferred.await(state.waitBeforeReconcile);
    }),
  cleanup: Effect.gen(function* () {
    state.calls.push(`cleanup:${state.lastLifecycle ?? "invalid"}`);
    if (state.failCleanupOnce) {
      state.failCleanupOnce = false;
      return yield* new StackReconciliationError({ message: "cleanup failed" });
    }
  }),
  destroyData: Effect.gen(function* () {
    state.calls.push(`destroy-data:${state.lastLifecycle ?? "invalid"}`);
    if (state.failDestroyData)
      return yield* new StackReconciliationError({ message: "destroy-data failed" });
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
    const controller = yield* makeLifecycleController({
      stackId: id,
      runtime,
      stateStore: store,
      backend: backend(state),
    });
    return { id, root, store, state, controller };
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
        expect(result.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(fixture.state.calls).toEqual(["preflight", "reconcile:running"]);
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
        expect(third.inputFingerprint).toBe(first.inputFingerprint);
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
        expect(fixture.state.calls).toEqual(["reconcile:running"]);
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
        expect(fixture.state.calls).toEqual(["reconcile:stopped", "cleanup:stopped"]);
        fixture.state.calls.length = 0;
        const second = yield* fixture.controller.stop();
        expect(second).toEqual(first);
        expect(fixture.state.calls).toEqual(["reconcile:stopped", "cleanup:stopped"]);
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
        expect(errorOf(first)).toBeInstanceOf(StackReconciliationError);
        const stopped = yield* fixture.store.read(fixture.id);
        expect(stopped?.desiredLifecycle).toBe("stopped");
        fixture.state.calls.length = 0;
        const second = yield* fixture.controller.stop();
        expect(second.desiredLifecycle).toBe("stopped");
        expect(fixture.state.calls).toEqual(["reconcile:stopped", "cleanup:stopped"]);
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
        expect(errorOf(exit)).toBeInstanceOf(StackReconciliationError);
        expect(yield* fixture.store.read(fixture.id)).toMatchObject({
          desiredLifecycle: "stopped",
          definition: first.definition,
          inputFingerprint: first.inputFingerprint,
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
        expect(fixture.state.calls).toEqual([
          "reconcile:destroying",
          "cleanup:destroying",
          "destroy-data:destroying",
        ]);
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
        expect(errorOf(exit)).toBeInstanceOf(StackReconciliationError);
        expect(yield* fixture.store.read(fixture.id)).toMatchObject({
          desiredLifecycle: "destroying",
        });
        expect(fixture.state.calls).toEqual([
          "reconcile:destroying",
          "cleanup:destroying",
          "destroy-data:destroying",
        ]);
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
