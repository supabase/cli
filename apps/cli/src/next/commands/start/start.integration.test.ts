import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { start, type StartOperations, type StartStack } from "./start.handler.ts";
import { CAPABILITY_NAMES, StackIdSchema, StackUpgradeRequiredError } from "@supabase/stack/effect";
import type { StackStatus } from "@supabase/stack/effect";
import { emptyEnv, mockOutput } from "../../../../tests/helpers/mocks.ts";

describe("start handler", () => {
  it.live("reports runtime startup failures through the command boundary", () => {
    const out = mockOutput({ interactive: false });
    return start({ stack: "default", mode: "native", exclude: [], detach: true }).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))),
    );
  });

  it.live("prepares the translated config before starting the managed stack", () => {
    const out = mockOutput({ interactive: false });
    const events: Array<string> = [];
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
      prepare: () =>
        Effect.sync(() => {
          events.push("prepare");
          return { capabilities: [] };
        }),
      start: () =>
        Effect.sync(() => {
          events.push("start");
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
          expect(events).toEqual(["prepare", "start"]);
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
      prepare: () => Effect.succeed({ capabilities: [] }),
      start: () =>
        Effect.fail(
          new StackUpgradeRequiredError({
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
            expect(failure).toBeInstanceOf(StackUpgradeRequiredError);
            if (failure instanceof StackUpgradeRequiredError)
              expect(failure.message).toContain("supabase restart");
          }
        }),
      ),
    );
  });
});
