import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import type { CapabilityName } from "../public/Capability.ts";
import { CAPABILITY_NAMES } from "../public/Capability.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import { RuntimeDriverError, type RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import { makeNativeRuntime } from "../runtime/NativeRuntime.ts";
import { makeSessionLauncher } from "./SessionLauncher.ts";

const stackId = StackIdSchema.make("b".repeat(64));

const workload = (id: string, dependencies: ReadonlyArray<string> = []): PlannedWorkload => ({
  id,
  capability: "database",
  dependencies,
  readiness: {},
  artifacts: {
    native: { kind: "native", release: "test" },
    container: { kind: "container", image: "test/image" },
  },
  selected: { kind: "native", release: "test" },
});

const plan = (workloads: ReadonlyArray<PlannedWorkload>): ExecutionPlan => {
  const activation = {
    database: "eager",
    rest: "lazy",
    auth: "lazy",
    realtime: "lazy",
    storage: "lazy",
    functions: "lazy",
    studio: "lazy",
    mail: "lazy",
    analytics: "lazy",
    pooler: "lazy",
  } satisfies { [Name in CapabilityName]: "eager" | "lazy" };
  const dependencies = {
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
  } satisfies { [Name in CapabilityName]: ReadonlyArray<CapabilityName> };
  return {
    runtime: { kind: "native" },
    activation,
    startOrder: CAPABILITY_NAMES,
    dependencies,
    routes: [],
    workloads,
  };
};

const ready = (workload: PlannedWorkload) => ({
  stackId,
  workloadId: workload.id,
  state: "ready" as const,
});

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("session launcher", () => {
  it.live("starts independent workloads in parallel before their dependants", () =>
    Effect.gen(function* () {
      const databaseEntered = yield* Deferred.make<void>();
      const releaseDatabase = yield* Deferred.make<void>();
      const mailEntered = yield* Deferred.make<void>();
      const calls: string[] = [];
      const database = workload("database:database");
      const mail = workload("mail:mail");
      const rest = workload("rest:rest", [database.id]);
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: (_key, current) =>
          Effect.gen(function* () {
            calls.push(`start:${current.id}`);
            if (current.id === database.id) {
              yield* Deferred.succeed(databaseEntered, undefined);
              yield* Deferred.await(releaseDatabase);
            }
            if (current.id === mail.id) yield* Deferred.succeed(mailEntered, undefined);
            return ready(current);
          }),
        stop: (key) => Effect.sync(() => calls.push(`stop:${key.workloadId}`)),
        remove: (key) => Effect.sync(() => calls.push(`remove:${key.workloadId}`)),
        cleanup: () => Effect.void,
      };
      const launcher = yield* makeSessionLauncher({ stackId, driver });
      const launching = yield* Effect.forkChild(launcher.launch(plan([database, mail, rest])), {
        startImmediately: true,
      });

      yield* Deferred.await(databaseEntered);
      yield* Deferred.await(mailEntered);
      expect(calls).toContain("start:database:database");
      expect(calls).toContain("start:mail:mail");
      expect(calls).not.toContain("start:rest:rest");

      yield* Deferred.succeed(releaseDatabase, undefined);
      yield* Fiber.join(launching);
      expect(calls).toContain("start:rest:rest");
    }),
  );

  it.live("interrupts and removes an in-flight native workload when a sibling fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const databaseEntered = yield* Deferred.make<void>();
        const databaseInterrupted = yield* Deferred.make<void>();
        const database = workload("database:database");
        const mail = workload("mail:mail");
        const driver = yield* makeNativeRuntime({
          resolveProcess: (key) => {
            if (key.workloadId === database.id)
              return Effect.gen(function* () {
                yield* Deferred.succeed(databaseEntered, undefined);
                return yield* Effect.never;
              }).pipe(Effect.ensuring(Deferred.succeed(databaseInterrupted, undefined)));
            return Deferred.await(databaseEntered).pipe(
              Effect.andThen(
                Effect.fail(
                  new RuntimeDriverError({
                    message: "mail failed",
                    stackId,
                    workloadId: key.workloadId,
                  }),
                ),
              ),
            );
          },
          waitForReadiness: () => Effect.never,
        });
        const launcher = yield* makeSessionLauncher({ stackId, driver });
        const launching = yield* Effect.forkChild(launcher.launch(plan([database, mail])), {
          startImmediately: true,
        });
        yield* Deferred.await(databaseEntered);
        const result = yield* Fiber.join(launching).pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
        yield* Deferred.await(databaseInterrupted);
        expect(yield* driver.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("fails with a typed error when no pending workload can become ready", () =>
    Effect.gen(function* () {
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: () => Effect.die("unreachable"),
        stop: () => Effect.die("unreachable"),
        remove: () => Effect.die("unreachable"),
        cleanup: () => Effect.void,
      };
      const launcher = yield* makeSessionLauncher({ stackId, driver });
      const result = yield* launcher
        .launch(plan([workload("cycle:a", ["cycle:b"]), workload("cycle:b", ["cycle:a"])]))
        .pipe(Effect.exit);
      const error = Exit.isFailure(result)
        ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
        : undefined;
      expect(error).toBeInstanceOf(RuntimeDriverError);
    }),
  );
});
