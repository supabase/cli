import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { start, type StartOperations, type StartStack } from "./start.handler.ts";
import {
  CAPABILITY_NAMES,
  ServiceStartError,
  StackIdSchema,
  StackMustBeStoppedError,
} from "@supabase/stack/effect";
import type { StackStatus } from "@supabase/stack/effect";
import { emptyEnv, mockCliProjectHome, mockOutput } from "../../../../tests/helpers/mocks.ts";

describe("start handler", () => {
  it.live("preserves the runtime startup failure tag through the command boundary", () => {
    const out = mockOutput({ interactive: false });
    const stack: StartStack = {
      start: () => Effect.fail(new ServiceStartError({ message: "auth failed" })),
    };
    const operations: StartOperations = {
      createStack: () => Effect.succeed(stack),
      loadConfig: () => Effect.succeed(undefined),
    };
    return start({ stack: "default", mode: "native", exclude: [], detach: true }, operations).pipe(
      Effect.provide(
        Layer.mergeAll(emptyEnv(), out.layer, mockCliProjectHome({ projectRoot: process.cwd() })),
      ),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
            expect(failure).toBeInstanceOf(ServiceStartError);
            if (failure instanceof ServiceStartError) expect(failure.message).toBe("auth failed");
          }
        }),
      ),
    );
  });

  it.live("starts the managed stack with the translated config", () => {
    const out = mockOutput({ interactive: false });
    let receivedConfig: unknown;
    const id = StackIdSchema.make(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const status: StackStatus = {
      id,
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
    const stack: StartStack = {
      start: (options) =>
        Effect.sync(() => {
          receivedConfig = options?.config;
          return status;
        }),
    };
    const operations: StartOperations = {
      createStack: () => Effect.succeed(stack),
      loadConfig: () => Effect.succeed(undefined),
    };
    return start({ stack: "default", mode: "native", exclude: [], detach: true }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(receivedConfig).toBeDefined();
          expect(out.messages).toContainEqual(
            expect.objectContaining({ message: "Local Supabase stack is running." }),
          );
        }),
      ),
    );
  });

  it.live("preserves explicit restart guidance when running input changed", () => {
    const out = mockOutput({ interactive: false });
    const stack: StartStack = {
      start: () =>
        Effect.fail(
          new StackMustBeStoppedError({
            message: "Running stack input changed; call restart explicitly to apply it",
            guidance: "Use restart() to apply stopped-time changes",
          }),
        ),
    };
    const operations: StartOperations = {
      createStack: () => Effect.succeed(stack),
      loadConfig: () => Effect.succeed(undefined),
    };
    return start({ stack: "default", mode: "native", exclude: [], detach: true }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
            expect(failure).toBeInstanceOf(StackMustBeStoppedError);
            if (failure instanceof StackMustBeStoppedError)
              expect(failure.message).toContain("supabase restart");
          }
        }),
      ),
    );
  });
});
