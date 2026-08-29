import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  RuntimeDriverError,
  RuntimeGenerationMismatchError,
  RuntimeReadinessTimeoutError,
} from "../runtime/RuntimeDriver.ts";
import type { RuntimeDriver, ObservedWorkload } from "../runtime/RuntimeDriver.ts";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import { StackIdSchema } from "../public/StackId.ts";
import { makeReconciler } from "./Reconciler.ts";

const stackId = StackIdSchema.make("b".repeat(64));
const workload = (
  id: string,
  dependencies: ReadonlyArray<string> = [],
  restart = { maxAttempts: 1, backoffMs: 0 },
): PlannedWorkload => ({
  id,
  capability: "database",
  dependencies,
  readiness: { mode: "tcp" },
  restart,
  artifacts: {
    native: { kind: "native", service: id, release: "test" },
    container: { kind: "container", service: id, image: `test/${id}` },
  },
  selected: { kind: "native", service: id, release: "test" },
  specHash: id,
});
const planFor = (workloads: ReadonlyArray<PlannedWorkload>): ExecutionPlan => ({
  runtime: { kind: "native" },
  activation: {
    database: "eager",
    rest: "eager",
    auth: "eager",
    realtime: "eager",
    storage: "eager",
    functions: "eager",
    studio: "eager",
    mail: "eager",
    analytics: "eager",
    pooler: "eager",
  },
  startOrder: ["database"],
  stopOrder: ["database"],
  dependencies: {
    database: [],
    rest: [],
    auth: [],
    realtime: [],
    storage: [],
    functions: [],
    studio: [],
    mail: [],
    analytics: [],
    pooler: [],
  },
  routes: [],
  workloads,
});

const fakeDriver = (options: {
  readonly fail?: ReadonlySet<string>;
  readonly never?: ReadonlySet<string>;
}) =>
  Effect.gen(function* () {
    const resources = yield* Ref.make<ReadonlyArray<ObservedWorkload>>([]);
    const starts = yield* Ref.make<ReadonlyArray<string>>([]);
    const driver: RuntimeDriver = {
      observe: () => Ref.get(resources),
      start: (key, entry) =>
        Effect.gen(function* () {
          yield* Ref.update(starts, (current) => [...current, entry.id]);
          if (options.never?.has(entry.id)) return yield* Effect.never;
          if (options.fail?.has(entry.id))
            return yield* new RuntimeDriverError({
              message: `failed ${entry.id}`,
              stackId: key.stackId,
              workloadId: entry.id,
            });
          const ready: ObservedWorkload = { ...key, state: "ready" };
          yield* Ref.update(resources, (current) => [
            ...current.filter(({ workloadId }) => workloadId !== key.workloadId),
            ready,
          ]);
          return ready;
        }),
      stop: (key) =>
        Ref.update(resources, (current) =>
          current.map((entry) =>
            entry.workloadId === key.workloadId ? { ...entry, state: "stopped" } : entry,
          ),
        ),
      remove: (key) =>
        Ref.update(resources, (current) =>
          current.filter((entry) => entry.workloadId !== key.workloadId),
        ),
    };
    return { driver, resources, starts };
  });

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("stack reconciler", () => {
  it.live("keeps independent branches running and blocks failed dependents", () =>
    Effect.gen(function* () {
      const { driver, starts } = yield* fakeDriver({ fail: new Set(["root"]) });
      const reconciler = yield* makeReconciler({ driver, readGeneration: () => Effect.succeed(1) });
      const result = yield* reconciler.reconcile({
        stackId,
        desiredGeneration: 1,
        desiredLifecycle: "running",
        plan: planFor([workload("root"), workload("dependent", ["root"]), workload("independent")]),
      });
      expect(yield* Ref.get(starts)).toEqual(["root", "independent"]);
      expect(result.failed.map(({ workloadId }) => workloadId)).toEqual(["root"]);
      expect(result.blocked).toEqual([{ workloadId: "dependent", dependencyId: "root" }]);
    }),
  );

  it.live("quiesces an already-ready dependent when its dependency exhausts", () =>
    Effect.gen(function* () {
      const { driver, resources } = yield* fakeDriver({ fail: new Set(["root"]) });
      yield* Ref.set(resources, [
        { stackId, desiredGeneration: 1, workloadId: "root", specHash: "root", state: "failed" },
        {
          stackId,
          desiredGeneration: 1,
          workloadId: "dependent",
          specHash: "dependent",
          state: "ready",
        },
        {
          stackId,
          desiredGeneration: 1,
          workloadId: "leaf",
          specHash: "leaf",
          state: "ready",
        },
        {
          stackId,
          desiredGeneration: 1,
          workloadId: "independent",
          specHash: "independent",
          state: "ready",
        },
      ]);
      const reconciler = yield* makeReconciler({
        driver,
        readGeneration: () => Effect.succeed(1),
      });
      const result = yield* reconciler.reconcile({
        stackId,
        desiredGeneration: 1,
        desiredLifecycle: "running",
        plan: planFor([
          workload("root"),
          workload("dependent", ["root"]),
          workload("leaf", ["dependent"]),
          workload("independent"),
        ]),
      });
      expect(result.stopped).toContain("dependent");
      expect(result.removed).toContain("dependent");
      expect(result.stopped).toContain("leaf");
      expect(result.removed).toContain("leaf");
      expect((yield* Ref.get(resources)).map(({ workloadId }) => workloadId)).toContain(
        "independent",
      );
    }),
  );

  it.effect("reports a readiness deadline and preserves the bounded restart budget", () =>
    Effect.gen(function* () {
      const entered = [
        yield* Deferred.make<void>(),
        yield* Deferred.make<void>(),
        yield* Deferred.make<void>(),
        yield* Deferred.make<void>(),
      ] as const;
      const starts = yield* Ref.make(0);
      const generation = yield* Ref.make(1);
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: (_key) =>
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(starts, (count) => count + 1);
            const signal = entered[attempt - 1];
            if (signal !== undefined) yield* Deferred.succeed(signal, undefined);
            return yield* Effect.never;
          }),
        stop: () => Effect.void,
        remove: () => Effect.void,
      };
      const reconciler = yield* makeReconciler({
        driver,
        readGeneration: () => Ref.get(generation),
        readinessTimeout: "5 millis",
      });
      const request = {
        stackId,
        desiredGeneration: 1,
        desiredLifecycle: "running" as const,
        plan: planFor([workload("slow", [], { maxAttempts: 2, backoffMs: 0 })]),
      };
      const fiber = yield* Effect.forkChild(reconciler.reconcile(request), {
        startImmediately: true,
      });
      yield* Deferred.await(entered[0]);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(entered[1]);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      expect(result.failed[0]?.error).toBeInstanceOf(RuntimeReadinessTimeoutError);
      expect(yield* Ref.get(starts)).toBe(2);

      const second = yield* reconciler.reconcile({
        ...request,
      });
      expect(second.failed[0]?.error).toBeDefined();
      expect(yield* Ref.get(starts)).toBe(2);
      yield* Ref.set(generation, 2);
      const nextFiber = yield* Effect.forkChild(
        reconciler.reconcile({
          ...request,
          desiredGeneration: 2,
        }),
        { startImmediately: true },
      );
      yield* Deferred.await(entered[2]);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(entered[3]);
      yield* TestClock.adjust("1 second");
      const nextGeneration = yield* Fiber.join(nextFiber);
      expect(nextGeneration.failed[0]?.error).toBeInstanceOf(RuntimeReadinessTimeoutError);
      expect(yield* Ref.get(starts)).toBe(4);
    }),
  );

  it.live("serializes concurrent callers through one lifecycle semaphore", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);
      const resources = yield* Ref.make<ReadonlyArray<ObservedWorkload>>([]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const driver: RuntimeDriver = {
        observe: () => Ref.get(resources),
        start: (key, _entry) =>
          Effect.gen(function* () {
            yield* Ref.update(active, (value) => value + 1);
            const current = yield* Ref.get(active);
            yield* Ref.update(maxActive, (max) => Math.max(max, current));
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            const ready: ObservedWorkload = { ...key, state: "ready" };
            yield* Ref.update(resources, (entries) => [...entries, ready]);
            return ready;
          }).pipe(Effect.ensuring(Ref.update(active, (value) => value - 1))),
        stop: () => Effect.void,
        remove: () => Effect.void,
      };
      const reconciler = yield* makeReconciler({ driver, readGeneration: () => Effect.succeed(1) });
      const request = {
        stackId,
        desiredGeneration: 1,
        desiredLifecycle: "running" as const,
        plan: planFor([workload("one")]),
      };
      const first = yield* Effect.forkChild(reconciler.reconcile(request), {
        startImmediately: true,
      });
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(reconciler.reconcile(request), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      expect(yield* Ref.get(active)).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Ref.get(maxActive)).toBe(1);
    }),
  );

  it.live("fences a generation change after a driver mutation without retrying", () =>
    Effect.gen(function* () {
      const generation = yield* Ref.make(1);
      const starts = yield* Ref.make(0);
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: (key, _entry) => {
          const ready: ObservedWorkload = { ...key, state: "ready" };
          return Ref.update(starts, (count) => count + 1).pipe(
            Effect.andThen(Ref.set(generation, 2)),
            Effect.andThen(Effect.succeed(ready)),
          );
        },
        stop: () => Effect.void,
        remove: () => Effect.void,
      };
      const reconciler = yield* makeReconciler({
        driver,
        readGeneration: () => Ref.get(generation),
      });
      const exit = yield* reconciler
        .reconcile({
          stackId,
          desiredGeneration: 1,
          desiredLifecycle: "running",
          plan: planFor([workload("fenced")]),
        })
        .pipe(Effect.exit);
      expect(failureOf(exit)).toBeInstanceOf(RuntimeGenerationMismatchError);
      expect(yield* Ref.get(starts)).toBe(1);
    }),
  );

  it.live("releases lifecycle serialization when a waiting caller is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocked = yield* Ref.make(true);
      const starts = yield* Ref.make(0);
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: (key) => {
          const ready: ObservedWorkload = { ...key, state: "ready" };
          return Ref.update(starts, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(
              Effect.flatMap(Ref.get(blocked), (isBlocked) =>
                isBlocked ? Deferred.await(release) : Effect.void,
              ),
            ),
            Effect.andThen(Effect.succeed(ready)),
          );
        },
        stop: () => Effect.void,
        remove: () => Effect.void,
      };
      const reconciler = yield* makeReconciler({
        driver,
        readGeneration: () => Effect.succeed(1),
      });
      const request = {
        stackId,
        desiredGeneration: 1,
        desiredLifecycle: "running" as const,
        plan: planFor([workload("interruptible")]),
      };
      const first = yield* Effect.forkChild(reconciler.reconcile(request), {
        startImmediately: true,
      });
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      yield* Ref.set(blocked, false);
      yield* Deferred.succeed(release, undefined);
      const second = yield* reconciler.reconcile(request);
      expect(second.started).toEqual(["interruptible"]);
      expect(yield* Ref.get(starts)).toBe(2);
    }),
  );

  it.live("stops before removing workloads in reverse dependency order", () =>
    Effect.gen(function* () {
      const trace = yield* Ref.make<ReadonlyArray<string>>([]);
      const resources: ReadonlyArray<ObservedWorkload> = [
        { stackId, desiredGeneration: 1, workloadId: "a", specHash: "a", state: "ready" },
        { stackId, desiredGeneration: 1, workloadId: "b", specHash: "b", state: "ready" },
      ];
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed(resources),
        start: () => Effect.die("unexpected start"),
        stop: (key) => Ref.update(trace, (current) => [...current, `stop:${key.workloadId}`]),
        remove: (key) => Ref.update(trace, (current) => [...current, `remove:${key.workloadId}`]),
      };
      const reconciler = yield* makeReconciler({
        driver,
        readGeneration: () => Effect.succeed(1),
      });
      yield* reconciler.reconcile({
        stackId,
        desiredGeneration: 1,
        desiredLifecycle: "stopped",
        plan: planFor([workload("a"), workload("b", ["a"])]),
      });
      expect(yield* Ref.get(trace)).toEqual(["stop:b", "stop:a", "remove:b", "remove:a"]);
    }),
  );

  it.live("resets a generation-scoped restart budget after an explicit stop", () =>
    Effect.gen(function* () {
      const { driver, starts } = yield* fakeDriver({ fail: new Set(["retryable"]) });
      const reconciler = yield* makeReconciler({
        driver,
        readGeneration: () => Effect.succeed(1),
      });
      const request = {
        stackId,
        desiredGeneration: 1,
        desiredLifecycle: "running" as const,
        plan: planFor([workload("retryable")]),
      };
      const first = yield* reconciler.reconcile(request);
      expect(first.failed).toHaveLength(1);
      expect(yield* Ref.get(starts)).toEqual(["retryable"]);
      yield* reconciler.reconcile({ ...request, desiredLifecycle: "stopped" });
      yield* reconciler.reconcile(request);
      expect(yield* Ref.get(starts)).toEqual(["retryable", "retryable"]);
    }),
  );

  it.live("preserves defects in a mixed driver Cause instead of reporting budget exhaustion", () =>
    Effect.gen(function* () {
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: () =>
          Effect.failCause(
            Cause.combine(
              Cause.fail(
                new RuntimeDriverError({ message: "start failed", stackId, workloadId: "mixed" }),
              ),
              Cause.die("driver defect"),
            ),
          ),
        stop: () => Effect.void,
        remove: () => Effect.void,
      };
      const reconciler = yield* makeReconciler({
        driver,
        readGeneration: () => Effect.succeed(1),
      });
      const exit = yield* reconciler
        .reconcile({
          stackId,
          desiredGeneration: 1,
          desiredLifecycle: "running",
          plan: planFor([workload("mixed")]),
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
    }),
  );
});
