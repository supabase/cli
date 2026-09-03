import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { StackIdSchema } from "@supabase/stack/effect";
import type { StackStatus } from "@supabase/stack/effect";
import {
  CAPABILITY_NAMES,
  StackLifecycleConflictError,
  StackUpgradeRequiredError,
} from "@supabase/stack/effect";
import { mockCliProjectHome, mockOutput, emptyEnv } from "../../../../tests/helpers/mocks.ts";
import { restart, type RestartOperations, type RestartStack } from "./restart.handler.ts";

const stackId = StackIdSchema.make(
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
);
const status: StackStatus = {
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: name === "functions" ? "lazy" : "eager",
    state: name === "functions" ? "dormant" : "ready",
  })),
};

describe("restart handler", () => {
  it.live("stops before starting the managed stack with translated config", () => {
    const events: Array<string> = [];
    let receivedConfig: unknown;
    const output = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      const stopStarted = yield* Deferred.make<void>();
      const stopRelease = yield* Deferred.make<void>();
      const stopFinished = yield* Deferred.make<void>();
      const startCalled = yield* Deferred.make<void>();
      const stack: RestartStack = {
        stop: () =>
          Effect.gen(function* () {
            events.push("stop-started");
            yield* Deferred.succeed(stopStarted, undefined);
            yield* Deferred.await(stopRelease);
            events.push("stop-finished");
            yield* Deferred.succeed(stopFinished, undefined);
          }),
        start: (options) =>
          Effect.gen(function* () {
            events.push("start");
            receivedConfig = options?.config;
            yield* Deferred.succeed(startCalled, undefined);
            return status;
          }),
      };
      const operations: RestartOperations = {
        findStack: () =>
          Effect.succeed(
            Option.some({
              id: stackId,
              projectRoot: process.cwd(),
              name: "default",
              branchContext: "refs/heads/main",
              runtime: { kind: "native" as const },
              desiredLifecycle: "running" as const,
            }),
          ),
        openStack: () => Effect.succeed(stack),
        loadConfig: () => Effect.succeed(undefined),
      };
      const run = yield* Effect.forkChild(
        restart({ stack: "default", exclude: ["auth"] }, operations),
      );
      yield* Deferred.await(stopStarted);
      expect(Option.isNone(yield* Deferred.poll(startCalled))).toBe(true);
      yield* Deferred.succeed(stopRelease, undefined);
      yield* Fiber.join(run);
      expect(Option.isSome(yield* Deferred.poll(stopFinished))).toBe(true);
      expect(events).toEqual(["stop-started", "stop-finished", "start"]);
      expect(receivedConfig).toMatchObject({
        capabilities: { auth: { enabled: false } },
      });
      expect(output.messages).toContainEqual(
        expect.objectContaining({ message: "Local Supabase stack restarted." }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          emptyEnv(),
          output.layer,
          mockCliProjectHome({ projectRoot: process.cwd() }),
        ),
      ),
    );
  });

  it.live("propagates an upgrade-required restart failure", () => {
    const output = mockOutput({ interactive: false });
    const operations: RestartOperations = {
      findStack: () =>
        Effect.succeed(
          Option.some({
            id: stackId,
            projectRoot: process.cwd(),
            name: "default",
            branchContext: "refs/heads/main",
            runtime: { kind: "native" as const },
            desiredLifecycle: "running" as const,
          }),
        ),
      openStack: () =>
        Effect.succeed({
          stop: () => Effect.void,
          start: () =>
            Effect.fail(new StackUpgradeRequiredError({ message: "owner upgrade required" })),
        }),
      loadConfig: () => Effect.succeed(undefined),
    };
    return restart({ stack: "default", exclude: [] }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), output.layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) expect(error.value).toBeInstanceOf(StackUpgradeRequiredError);
          }
        }),
      ),
    );
  });

  it.live("stops on failure without invoking start", () => {
    let startCalled = false;
    const output = mockOutput({ interactive: false });
    const stopError = new StackLifecycleConflictError({ message: "stop still in progress" });
    const operations: RestartOperations = {
      findStack: () =>
        Effect.succeed(
          Option.some({
            id: stackId,
            projectRoot: process.cwd(),
            name: "default",
            branchContext: "refs/heads/main",
            runtime: { kind: "native" as const },
            desiredLifecycle: "running" as const,
          }),
        ),
      openStack: () =>
        Effect.succeed({
          stop: () => Effect.fail(stopError),
          start: () =>
            Effect.sync(() => {
              startCalled = true;
              return status;
            }),
        }),
      loadConfig: () => Effect.succeed(undefined),
    };
    return restart({ stack: "default", exclude: [] }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), output.layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(startCalled).toBe(false);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) expect(error.value).toBe(stopError);
          }
        }),
      ),
    );
  });
});
